import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { ConcurrencyError, WoodshedStore } from "./kv.ts";
import { computeDeadline, emptyWoodshed, type WoodshedRecord } from "./domain/mod.ts";

/** Each test gets its own in-memory KV, so nothing leaks between them. */
async function withStore(fn: (store: WoodshedStore) => Promise<void>): Promise<void> {
  const store = await WoodshedStore.open(":memory:");
  try {
    await fn(store);
  } finally {
    store.close();
  }
}

function seed(overrides: Partial<WoodshedRecord> = {}): WoodshedRecord {
  return {
    ...emptyWoodshed({
      vaultId: "vault-ws1",
      claimVaultId: "vault-claim",
      rootVaultId: "vault-root",
      claimNumber: "10000001",
      wsNumber: 1,
      now: "2026-07-09T00:00:00.000Z",
    }),
    ...overrides,
  };
}

Deno.test("create then get round-trips the record", async () => {
  await withStore(async (store) => {
    await store.create(seed());
    const found = await store.get("vault-ws1");

    assertEquals(found?.claimNumber, "10000001");
    assertEquals(found?.status, "DRAFT");
    assertEquals(found?.revision, 0);
  });
});

Deno.test("get returns null for an unknown vault rather than throwing", async () => {
  await withStore(async (store) => {
    assertEquals(await store.get("nope"), null);
  });
});

Deno.test("create refuses to overwrite an existing record", async () => {
  await withStore(async (store) => {
    await store.create(seed());
    await assertRejects(() => store.create(seed()), ConcurrencyError);
  });
});

Deno.test("update bumps the revision and timestamp", async () => {
  await withStore(async (store) => {
    await store.create(seed());
    const updated = await store.update("vault-ws1", (record) => {
      record.meetingDate = "2026-07-09";
      return record;
    });

    assertEquals(updated.revision, 1);
    assertEquals(updated.meetingDate, "2026-07-09");
    assertEquals(updated.updatedAt > updated.createdAt, true);
  });
});

Deno.test("concurrent updates both land — neither is silently lost", async () => {
  // This is the guarantee the platform itself does not give: PUT /vaults/{id} is
  // last-write-wins, so two auditors editing one Woodshed would drop a write.
  await withStore(async (store) => {
    await store.create(seed());

    await Promise.all([
      store.update("vault-ws1", (r) => {
        r.participants.push({
          id: "p1",
          role: "SME",
          email: "sme@example.com",
          addedAt: "2026-07-09T00:00:00.000Z",
        });
        return r;
      }),
      store.update("vault-ws1", (r) => {
        r.participants.push({
          id: "p2",
          role: "Adjuster",
          email: "adjuster.one@example.com",
          addedAt: "2026-07-09T00:00:00.000Z",
        });
        return r;
      }),
    ]);

    const final = await store.get("vault-ws1");
    assertEquals(final?.participants.length, 2);
    assertEquals(final?.revision, 2);
    assertEquals(
      final?.participants.map((p) => p.id).sort(),
      ["p1", "p2"],
    );
  });
});

Deno.test("update on a missing record throws instead of creating one", async () => {
  await withStore(async (store) => {
    await assertRejects(() => store.update("ghost", (r) => r));
  });
});

Deno.test("transition enforces the status machine", async () => {
  await withStore(async (store) => {
    await store.create(seed());

    await store.transition("vault-ws1", "SUBMITTED");
    assertEquals((await store.get("vault-ws1"))?.status, "SUBMITTED");

    // DRAFT → CLOSED skips three states.
    await store.create(seed({ vaultId: "vault-ws2", wsNumber: 2 }));
    await assertRejects(() => store.transition("vault-ws2", "CLOSED"));
  });
});

Deno.test("transition to the current status is a no-op, not an error", async () => {
  await withStore(async (store) => {
    await store.create(seed());
    const same = await store.transition("vault-ws1", "DRAFT");
    assertEquals(same.status, "DRAFT");
  });
});

Deno.test("WS numbers are allocated without collision under concurrency", async () => {
  await withStore(async (store) => {
    const allocated = await Promise.all(
      Array.from({ length: 8 }, () => store.allocateWsNumber("vault-claim")),
    );
    assertEquals([...allocated].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

Deno.test("WS numbering respects sessions created outside this server", async () => {
  await withStore(async (store) => {
    // KV knows nothing, but Filedgr already has WS1..WS3.
    assertEquals(await store.allocateWsNumber("vault-claim", [1, 2, 3]), 4);
    // The counter moved forward, so the next one continues from there.
    assertEquals(await store.allocateWsNumber("vault-claim"), 5);
  });
});

Deno.test("the counter never moves backwards", async () => {
  await withStore(async (store) => {
    assertEquals(await store.allocateWsNumber("vault-claim"), 1);
    assertEquals(await store.allocateWsNumber("vault-claim"), 2);
    // A stale `known` list must not reissue a number already handed out.
    assertEquals(await store.allocateWsNumber("vault-claim", [1]), 3);
  });
});

Deno.test("sessions are listed per claim, in WS order", async () => {
  await withStore(async (store) => {
    await store.create(seed({ vaultId: "b", wsNumber: 2 }));
    await store.create(seed({ vaultId: "a", wsNumber: 1 }));
    await store.create(seed({
      vaultId: "other",
      claimVaultId: "different-claim",
      wsNumber: 1,
    }));

    const sessions = await store.listByClaim("vault-claim");
    assertEquals(sessions.map((s) => s.vaultId), ["a", "b"]);
  });
});

Deno.test("the deadline index tracks open items and drops closed ones", async () => {
  await withStore(async (store) => {
    await store.create(seed({ meetingDate: "2026-07-09" }));

    await store.update("vault-ws1", (r) => {
      r.actionItems = [
        {
          id: "i1",
          item: "Upload Final SME Summary (PDF format)",
          role: "SME",
          owner_email: "sme@example.com",
          deadline: computeDeadline("2026-07-09"), // 2026-07-23
          status: "SENT",
          isSmeSummary: true,
          edited: false,
        },
        {
          id: "i2",
          item: "Monitor the upcoming statutory milestone",
          role: "Adjuster",
          owner_email: "adjuster.two@example.com",
          deadline: "2026-09-16",
          status: "OPEN",
          edited: false,
        },
      ];
      return r;
    });

    // Sweeping to 2026-07-31 catches the SME item but not the September one.
    assertEquals(
      (await store.dueThrough("2026-07-31")).map((d) => d.itemId),
      ["i1"],
    );
    assertEquals((await store.dueThrough("2026-12-31")).length, 2);

    // Returning the SME summary removes it from the sweep.
    await store.update("vault-ws1", (r) => {
      r.actionItems[0]!.status = "RETURNED";
      return r;
    });
    assertEquals(
      (await store.dueThrough("2026-12-31")).map((d) => d.itemId),
      ["i2"],
    );
  });
});

Deno.test("moving a deadline reindexes rather than leaving a stale entry", async () => {
  await withStore(async (store) => {
    await store.create(seed());
    await store.update("vault-ws1", (r) => {
      r.actionItems = [{
        id: "i1",
        item: "Chart review",
        role: "SME",
        owner_email: "sme@example.com",
        deadline: "2026-07-14",
        status: "OPEN",
        edited: false,
      }];
      return r;
    });
    assertEquals((await store.dueThrough("2026-07-20")).length, 1);

    await store.update("vault-ws1", (r) => {
      r.actionItems[0]!.deadline = "2026-08-30";
      return r;
    });

    assertEquals((await store.dueThrough("2026-07-20")).length, 0);
    assertEquals((await store.dueThrough("2026-08-31")).length, 1);
  });
});

Deno.test("upload tokens are single-use", async () => {
  await withStore(async (store) => {
    const token = await store.issueUploadToken({
      vaultId: "vault-ws1",
      actionItemId: "i1",
      ownerEmail: "sme@example.com",
      role: "SME",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });

    assertEquals((await store.readUploadToken(token))?.actionItemId, "i1");
    assertEquals((await store.consumeUploadToken(token))?.actionItemId, "i1");
    // A leaked link cannot be replayed.
    assertEquals(await store.consumeUploadToken(token), null);
  });
});

Deno.test("expired upload tokens are refused", async () => {
  await withStore(async (store) => {
    const token = await store.issueUploadToken({
      vaultId: "vault-ws1",
      actionItemId: "i1",
      ownerEmail: "sme@example.com",
      role: "SME",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    assertEquals(await store.readUploadToken(token), null);
    assertEquals(await store.consumeUploadToken(token), null);
  });
});

Deno.test("an unknown token resolves to null", async () => {
  await withStore(async (store) => {
    assertEquals(await store.readUploadToken("not-a-real-token"), null);
  });
});
