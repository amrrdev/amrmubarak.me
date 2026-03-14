---
title: "Concurrency Control in Databases: How to Handle Many Things Happening at Once"
date: "2026-3-14"
readTime: "10 min read"
category: "Database Internals"
---

## Introduction

Your application has one user. Concurrency is not a problem. That user reads data, writes data, nothing conflicts with anything.

Then you have ten thousand users. Two of them update the same row at the same time. One reads data while another is halfway through writing it. Three of them try to book the last seat on the same flight simultaneously.

Now concurrency is your entire problem.

Databases don't just store data — they coordinate access to that data from thousands of simultaneous clients. Get this wrong and you get corrupted balances, double-booked seats, lost updates, and phantom data that appears and disappears mid-query.

This article covers everything about how databases manage concurrent access: the anomalies that make concurrency hard, pessimistic vs optimistic control, the locking model, Two-Phase Locking, MVCC, Serializable Snapshot Isolation, deadlocks, and how to observe all of it in a running PostgreSQL instance.

---

## Topics Covered

- Why concurrency is hard — the four anomalies
- Pessimistic vs Optimistic concurrency control
- Locks — shared, exclusive, row-level, table-level
- Two-Phase Locking (2PL)
- MVCC — how PostgreSQL lets readers and writers coexist
- Serializable Snapshot Isolation (SSI)
- Deadlocks — detection, prevention, and handling
- Observing concurrency issues in production

---

## The Problem: What Goes Wrong Without Concurrency Control

There are four classic anomalies that happen when concurrent transactions are not properly isolated. Each one is a specific way data can become wrong.

### Dirty Read

Transaction B writes a value but has not committed yet. Transaction A reads that uncommitted value. Then B rolls back. A has now made decisions based on data that never officially existed.

```
Step 1: Tx B  → UPDATE balance = 500   (not yet committed)
Step 2: Tx A  → SELECT balance         → sees 500 (dirty read)
Step 3: Tx B  → ROLLBACK               (balance reverts to 200)
Step 4: Tx A  → acts on 500            → wrong, that value never existed
```

### Non-Repeatable Read

Transaction A reads a row. Transaction B updates and commits it. Transaction A reads the same row again and gets a different value. Same query, same transaction, different result.

```
Step 1: Tx A  → SELECT balance WHERE id=1    → 200
Step 2: Tx B  → UPDATE balance = 500 WHERE id=1
Step 3: Tx B  → COMMIT
Step 4: Tx A  → SELECT balance WHERE id=1    → 500  (changed!)
```

The data changed underneath a transaction that was still in progress.

### Phantom Read

Transaction A queries a range of rows. Transaction B inserts a new row that falls inside that range and commits. Transaction A runs the same query again and gets extra rows.

```
Step 1: Tx A  → SELECT * WHERE age > 20      → 5 rows
Step 2: Tx B  → INSERT (name='Dave', age=25)
Step 3: Tx B  → COMMIT
Step 4: Tx A  → SELECT * WHERE age > 20      → 6 rows  (phantom appeared)
```

The new row that appeared in step 4 is called a phantom — it was not there the first time A looked.

### Lost Update

Two transactions both read the same value, compute a new value based on it, and write back. The second write silently overwrites the first. No error is thrown. The data is simply wrong.

```
Step 1: Tx A  → SELECT balance WHERE id=1    → 200
Step 2: Tx B  → SELECT balance WHERE id=1    → 200
Step 3: Tx A  → UPDATE balance = 200 + 100   → writes 300
Step 4: Tx B  → UPDATE balance = 200 + 50    → writes 250  (overwrites A!)
Step 5: Final balance = 250, should be 350
```

This is the most dangerous anomaly because nothing signals that anything went wrong. Both transactions committed successfully. The data is silently incorrect.

> **Takeaway**: The four anomalies — dirty reads, non-repeatable reads, phantom reads, lost updates — are the specific ways concurrent transactions corrupt data. Every concurrency control mechanism exists to prevent some or all of them. The lost update is the most dangerous because it produces no error.

---

## Pessimistic vs Optimistic Concurrency Control

There are two fundamental philosophies for managing concurrent access. They make opposite assumptions about how often conflicts happen.

### Pessimistic Concurrency Control

Assume conflicts will happen. Prevent them upfront by acquiring locks before touching data. If another transaction holds a conflicting lock, wait until it is released.

```
Tx A wants to update row 42:

Step 1: Acquire exclusive lock on row 42
        → if unavailable: WAIT
Step 2: Read current value
Step 3: Compute new value
Step 4: Write new value
Step 5: COMMIT → release lock
```

Safe by design — you can never have a lost update because you hold the lock the whole time. The cost: high-contention rows become serialization points. All transactions wanting that row queue behind each other.

### Optimistic Concurrency Control

Assume conflicts are rare. Do not lock anything upfront. Proceed freely, and at commit time validate that nothing conflicting happened in the meantime. If a conflict is detected, abort and retry.

```
Tx A wants to update row 42:

Step 1: Read row 42, note its current version (e.g., version=7)
Step 2: Compute new value
Step 3: At commit: check if row 42 is STILL version 7
        → if yes: write new value, set version=8, COMMIT
        → if no:  someone changed it — ABORT and retry from step 1
```

Zero lock contention on reads — transactions proceed without waiting. But when conflicts occur, you pay the full cost of a retry. High-contention workloads under optimistic control spend most of their time retrying.

**When to use which:**

Pessimistic is better for high-contention data, long transactions, and workloads where retries are expensive — financial transfers, inventory deduction. It is better to wait than to redo work.

Optimistic is better for low-contention workloads, short transactions, and read-heavy systems where conflicts are genuinely rare. It is better to proceed and occasionally retry than to always lock.

**PostgreSQL example — optimistic control with a version column:**

```sql
CREATE TABLE products (
    id      BIGSERIAL PRIMARY KEY,
    name    TEXT NOT NULL,
    stock   INT  NOT NULL,
    version INT  NOT NULL DEFAULT 0
);

-- Application reads the row and remembers the version
SELECT id, stock, version FROM products WHERE id = 1;
-- Returns: stock=100, version=7

-- Application writes back with a version check
UPDATE products
SET    stock   = 99,
       version = version + 1
WHERE  id      = 1
AND    version = 7;   -- conflict check: only succeeds if nobody changed it

-- Check affected rows:
-- 1 row affected → success, no conflict
-- 0 rows affected → conflict detected → retry from the SELECT
```

The `WHERE version = 7` is the entire conflict detection mechanism. If another transaction updated the row between the read and write, its version will now be 8 — the update affects zero rows, the application detects this and retries.

> **Takeaway**: Pessimistic control locks first, then acts — safe for high-contention data. Optimistic control acts first, validates at commit — efficient when conflicts are rare. PostgreSQL supports both: explicit locks for pessimistic, version columns for optimistic at the application layer.

---

## Locks: Shared, Exclusive, Row-Level, Table-Level

PostgreSQL has a rich locking system with multiple lock types at multiple granularities.

### Lock Modes

**Shared Lock (S)**: multiple transactions can hold shared locks on the same resource simultaneously. Used when you want to read something and prevent concurrent writes, but allow other readers.

**Exclusive Lock (X)**: only one transaction can hold an exclusive lock. Incompatible with all other locks — both shared and exclusive. Any `UPDATE`, `DELETE`, or `SELECT FOR UPDATE` acquires an exclusive row lock.

```
Lock compatibility:

              Shared    Exclusive
Shared          ✓           ✗
Exclusive       ✗           ✗
```

Two readers never block each other. Any writer blocks all other readers and writers on the same row.

### Row-Level Locks

Row-level locks target individual rows, allowing concurrent access to different rows in the same table. PostgreSQL has four row-level lock modes from strongest to weakest:

**FOR UPDATE** — the strongest. Locks the row exclusively. Blocks any other `FOR UPDATE`, `FOR NO KEY UPDATE`, `FOR SHARE`, or `FOR KEY SHARE`. Use this when you are about to modify or delete the row.

**FOR NO KEY UPDATE** — like `FOR UPDATE` but does not block `FOR KEY SHARE`. Used when updating non-key columns, avoids blocking foreign key checks from child tables.

**FOR SHARE** — shared lock. Blocks `FOR UPDATE` and `FOR NO KEY UPDATE` but allows other `FOR SHARE` and `FOR KEY SHARE`. Use when you need to read a row and prevent updates but allow other readers.

**FOR KEY SHARE** — the weakest. Only blocks `FOR UPDATE`. Used by foreign key checks — prevents the referenced row from being deleted while the check is in progress.

```sql
-- Lock a row exclusively before updating it
BEGIN;
SELECT * FROM orders WHERE id = 42 FOR UPDATE;
-- Row 42 is now locked. Any other transaction trying FOR UPDATE blocks here.
UPDATE orders SET status = 'processing' WHERE id = 42;
COMMIT;

-- NOWAIT — fail immediately instead of waiting
SELECT * FROM orders WHERE id = 42 FOR UPDATE NOWAIT;
-- ERROR: could not obtain lock on row in relation "orders"

-- SKIP LOCKED — skip rows that are already locked, return only available ones
SELECT * FROM jobs
WHERE  status = 'pending'
ORDER  BY created_at
FOR    UPDATE SKIP LOCKED
LIMIT  1;
-- Returns the first unlocked pending job.
-- Multiple workers can run this concurrently — each gets a different row.
-- This is how you build a distributed job queue directly in PostgreSQL.
```

`SKIP LOCKED` is one of PostgreSQL's most underused features. Without it, multiple workers pile up waiting for the same locked row. With it, each worker atomically claims a different available row and moves on.

### Table-Level Locks

Table-level locks apply to the entire table. PostgreSQL acquires them automatically for DDL and certain DML. The hierarchy from least to most restrictive:

```
ACCESS SHARE           → SELECT
                         compatible with everything except ACCESS EXCLUSIVE

ROW SHARE              → SELECT FOR UPDATE / FOR SHARE
                         blocks EXCLUSIVE and ACCESS EXCLUSIVE

ROW EXCLUSIVE          → INSERT, UPDATE, DELETE
                         blocks SHARE, SHARE ROW EXCLUSIVE, EXCLUSIVE, ACCESS EXCLUSIVE

SHARE UPDATE EXCLUSIVE → VACUUM, ANALYZE, CREATE INDEX CONCURRENTLY
                         blocks itself and everything above

SHARE                  → CREATE INDEX (non-concurrent)
                         blocks all writes, allows reads

SHARE ROW EXCLUSIVE    → CREATE TRIGGER
                         blocks all writes and SHARE

EXCLUSIVE              → blocks everything except ACCESS SHARE (reads still work)

ACCESS EXCLUSIVE       → ALTER TABLE, DROP TABLE, TRUNCATE, VACUUM FULL
                         blocks EVERYTHING including SELECT
```

`ACCESS EXCLUSIVE` is the dangerous one. Any DDL needing it blocks all queries — including reads — until the lock is granted. On a busy table with long-running queries, the `ALTER TABLE` waits for existing queries to finish, then a growing queue of new queries piles up behind it while it runs.

```sql
-- This blocks ALL reads and writes on users for the full duration
ALTER TABLE users ADD COLUMN preferences JSONB;

-- Check if anything is waiting for a lock right now
SELECT
    pid,
    relation::regclass     AS table_name,
    mode,
    granted,
    pg_blocking_pids(pid)  AS blocked_by,
    query
FROM  pg_locks
JOIN  pg_stat_activity USING (pid)
WHERE relation IS NOT NULL
ORDER BY granted, pid;

-- Find exactly who is blocking whom
SELECT
    blocked.pid        AS blocked_pid,
    blocked.query      AS blocked_query,
    blocking.pid       AS blocking_pid,
    blocking.query     AS blocking_query,
    blocking.state     AS blocking_state
FROM  pg_stat_activity blocked
JOIN  pg_stat_activity blocking
  ON  blocking.pid = ANY(pg_blocking_pids(blocked.pid))
WHERE NOT blocked.granted;
```

The second query is what you run when users report slowness and you suspect lock contention. It shows you exactly which query is blocking another, what the blocking query is, and whether it is idle (forgot to commit) or actively running.

> **Takeaway**: Row-level locks allow concurrent access to different rows. `ACCESS EXCLUSIVE` blocks everything — plan DDL migrations carefully. `FOR UPDATE SKIP LOCKED` is essential for job queues. Monitor `pg_locks` and `pg_stat_activity` to diagnose contention in production.

---

## Two-Phase Locking (2PL)

Two-Phase Locking is the theoretical foundation behind most pessimistic locking systems. It defines a single rule about when locks can be acquired and released.

**The rule**: a transaction has exactly two phases — a growing phase where it can only acquire locks, and a shrinking phase where it can only release locks. Once a transaction releases its first lock, it can never acquire another.

```
  Growing phase                Shrinking phase
  ─────────────                ───────────────
  Acquire lock on Row A   →
  Acquire lock on Row B   →
  Acquire lock on Row C   →    Release lock on Row A
          ▲                    Release lock on Row B
          │                    Release lock on Row C
     Lock point
(peak — most locks held)
```

The lock point — the peak between the two phases — defines the transaction's position in a serial execution order. Transactions with earlier lock points are serialized before those with later lock points. This is what makes 2PL provably serializable.

### Strict 2PL

Basic 2PL allows releasing locks mid-transaction. This creates **cascading aborts**:

```
Step 1: Tx A  → acquires lock on Row X, does some work
Step 2: Tx A  → releases lock on Row X  (basic 2PL allows this)
Step 3: Tx B  → reads Row X (A's uncommitted data)
Step 4: Tx A  → ABORT
Step 5: Tx B  → must also ABORT (it read data from an aborted transaction)
```

**Strict 2PL** fixes this by holding all locks until commit or abort. No releases during the transaction. PostgreSQL uses Strict 2PL for its explicit row locks.

```
Strict 2PL:

Step 1: BEGIN
Step 2: Acquire lock on Row A
Step 3: Acquire lock on Row B
Step 4: Acquire lock on Row C
Step 5: ... do all work ...
Step 6: COMMIT / ROLLBACK
        → Release Row A
        → Release Row B
        → Release Row C   (all released together at the end)
```

Because locks are held until commit, no other transaction can read uncommitted changes. Dirty reads and cascading aborts are impossible.

### The Inherent Problem: Deadlocks

2PL creates a fundamental problem — deadlocks. Because transactions hold locks while waiting for other locks, circular waits become possible.

```
Step 1: Tx A  → acquires lock on account id=1   ✓
Step 2: Tx B  → acquires lock on account id=2   ✓
Step 3: Tx A  → wants lock on account id=2      → WAITS for Tx B
Step 4: Tx B  → wants lock on account id=1      → WAITS for Tx A

A waits for B. B waits for A. Neither will ever proceed.
```

This is not a bug — it is an inherent consequence of holding locks while waiting for more. Any system using 2PL must detect and break deadlocks.

> **Takeaway**: 2PL separates lock acquisition from release into two phases. Strict 2PL holds all locks until commit, preventing cascading aborts. Deadlocks are an inherent consequence — not a bug — and must be detected and resolved.

---

## MVCC: Reads and Writes Without Blocking

The fundamental problem with pure locking: readers block writers and writers block readers. Every `SELECT` must wait for in-progress writes to finish, and every `UPDATE` must wait for in-progress reads. In a read-heavy system, this creates enormous contention.

**MVCC (Multi-Version Concurrency Control)** solves this by keeping multiple versions of each row. Writers create new versions instead of overwriting old ones. Readers see a snapshot from when their transaction started. They never block each other.

```
Without MVCC:
  Tx A (UPDATE) ──── holds lock ──────────────────► COMMIT
  Tx B (SELECT)               ── WAITS ───────────► runs after A

With MVCC:
  Tx A (UPDATE) ──── writes new version ──────────► COMMIT
  Tx B (SELECT) ──── reads old version  ──────────► COMMIT
  Both run simultaneously. Neither waits.
```

### How PostgreSQL Implements MVCC

Every row in PostgreSQL carries two hidden system columns:

- **xmin**: the transaction ID that inserted this row version
- **xmax**: the transaction ID that deleted or updated this row version (0 if the row is still live)

```
After INSERT by transaction 100:
  [xmin=100, xmax=0,   name="Alice", balance=1000]   ← live

After UPDATE by transaction 200 (sets balance=2000):
  [xmin=100, xmax=200, name="Alice", balance=1000]   ← dead (updated by 200)
  [xmin=200, xmax=0,   name="Alice", balance=2000]   ← live (created by 200)

After DELETE by transaction 300:
  [xmin=200, xmax=300, name="Alice", balance=2000]   ← dead (deleted by 300)
```

Visibility rule — a row version is visible to transaction T if:

```
xmin committed before T's snapshot was taken
AND one of:
  xmax = 0                    (row was never deleted)
  xmax not yet committed      (deletion is in-progress)
  xmax started after T's snapshot
```

Every transaction sees a consistent snapshot of the database as it existed at a specific point in time. It never sees uncommitted changes. It never sees changes committed after it started.

### READ COMMITTED vs REPEATABLE READ

The isolation level controls when the snapshot is taken:

```
READ COMMITTED (PostgreSQL default):
  Snapshot taken at the START OF EACH STATEMENT
  → Each query sees all commits before that query ran
  → Non-repeatable reads ARE possible

REPEATABLE READ:
  Snapshot taken at the START OF THE TRANSACTION
  → All queries in the transaction see the same consistent state
  → Non-repeatable reads are IMPOSSIBLE
  → Phantom reads are also IMPOSSIBLE (PostgreSQL goes beyond the SQL standard)
```

**PostgreSQL example:**

```sql
CREATE TABLE accounts (id INT PRIMARY KEY, balance INT);
INSERT INTO accounts VALUES (1, 1000);

-- Terminal 1: start a REPEATABLE READ transaction
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT balance FROM accounts WHERE id = 1;
-- Returns: 1000

-- Terminal 2: update and commit while Terminal 1 is still open
UPDATE accounts SET balance = 2000 WHERE id = 1;
COMMIT;

-- Terminal 1: read again (still inside the same transaction)
SELECT balance FROM accounts WHERE id = 1;
-- REPEATABLE READ  → still returns 1000  (snapshot fixed at transaction start)
-- READ COMMITTED   → would return 2000   (snapshot refreshed per statement)

COMMIT;
```

### The Cost: Dead Tuples

MVCC keeps old row versions alive until they are provably invisible to all active transactions. Deleted and updated rows accumulate as **dead tuples** in the heap, consuming space and slowing down sequential scans.

`VACUUM` reclaims dead tuple space. It scans heap pages, identifies tuples whose xmax is committed and older than the oldest active snapshot, removes their index entries, and marks their space reusable.

```sql
-- See dead tuple accumulation per table
SELECT
    relname                                                          AS table_name,
    n_live_tup                                                       AS live_rows,
    n_dead_tup                                                       AS dead_rows,
    round(n_dead_tup::numeric /
          NULLIF(n_live_tup + n_dead_tup, 0) * 100, 1)              AS dead_pct,
    last_vacuum,
    last_autovacuum
FROM  pg_stat_user_tables
ORDER BY n_dead_tup DESC;
```

A table with `dead_pct` above 10-20% means autovacuum is not keeping up. Lower `autovacuum_vacuum_scale_factor` for that table, or run `VACUUM` manually.

> **Takeaway**: MVCC gives each transaction a consistent snapshot. Readers never block writers. Writers never block readers. Dead tuples accumulate and need VACUUM. At `REPEATABLE READ`, the snapshot is fixed for the whole transaction. At `READ COMMITTED`, each statement gets a fresh snapshot.

---

## Serializable Snapshot Isolation (SSI)

MVCC with snapshot isolation prevents dirty reads, non-repeatable reads, and phantom reads. But it does not prevent all anomalies. The most subtle one is **write skew**.

### Write Skew

Write skew happens when two transactions each read overlapping data, make a decision based on what they read, and write to different rows. No row-level conflict is detected. Both commit. The result violates an invariant.

Classic example: a hospital requires at least one doctor on call at all times.

```sql
CREATE TABLE doctors (name TEXT PRIMARY KEY, on_call BOOLEAN);
INSERT INTO doctors VALUES ('Alice', true), ('Bob', true);
-- Invariant: at least one doctor must have on_call = true
```

Under `REPEATABLE READ`:

```
Step 1: Tx A (Alice)  → SELECT COUNT(*) WHERE on_call=true  → 2
Step 2: Tx B (Bob)    → SELECT COUNT(*) WHERE on_call=true  → 2
        (both see count=2, both decide it is safe to go off-call)
Step 3: Tx A          → UPDATE doctors SET on_call=false WHERE name='Alice'
Step 4: Tx B          → UPDATE doctors SET on_call=false WHERE name='Bob'
Step 5: Tx A          → COMMIT  ✓
Step 6: Tx B          → COMMIT  ✓

Result: both doctors off-call, invariant violated, no error thrown
```

Both transactions read the same data. Both wrote to different rows — no row-level conflict. Both committed. PostgreSQL's snapshot isolation had no mechanism to catch this.

### How SSI Detects Write Skew

**Serializable Snapshot Isolation** (enabled with `ISOLATION LEVEL SERIALIZABLE`) tracks **read-write dependencies** between transactions.

PostgreSQL builds a dependency graph as transactions run. An edge Tx A → Tx B means "A read something that B later wrote" (an rw-anti-dependency). If the graph contains a cycle (A → B → A), those transactions cannot be serialized in any order — one must be aborted.

```
In the doctors example:

  Tx A reads on_call rows → Tx B writes Alice's on_call row
  Tx B reads on_call rows → Tx A writes Bob's on_call row

  Dependency cycle: Tx A →(rw)→ Tx B →(rw)→ Tx A
  PostgreSQL detects the cycle and aborts one transaction.
```

**PostgreSQL example:**

```sql
-- Terminal 1
BEGIN ISOLATION LEVEL SERIALIZABLE;
SELECT COUNT(*) FROM doctors WHERE on_call = true;
-- Returns: 2
UPDATE doctors SET on_call = false WHERE name = 'Alice';
COMMIT;  -- succeeds

-- Terminal 2 (running concurrently)
BEGIN ISOLATION LEVEL SERIALIZABLE;
SELECT COUNT(*) FROM doctors WHERE on_call = true;
-- Returns: 2
UPDATE doctors SET on_call = false WHERE name = 'Bob';
COMMIT;
-- ERROR:  could not serialize access due to read/write dependencies among transactions
-- HINT:   The transaction might succeed if retried.
```

PostgreSQL aborts one transaction. The other commits. The invariant is preserved. The aborted transaction retries — it now reads `count=1`, decides it cannot go off-call, and returns an appropriate response to the user.

### SSI vs 2PL

Both achieve full serializability. The difference is how:

```
2PL Serializable:
  Reads acquire locks          → high contention
  Blocks on conflict           → transactions wait
  No false aborts
  Deadlocks possible

SSI Serializable:
  Reads proceed without locks  → low contention
  Aborts on conflict           → transactions retry
  False aborts possible (conservative detection)
  No deadlocks on reads
```

SSI has higher throughput for read-heavy workloads because reads do not acquire any locks. The tradeoff is false aborts — transactions that could have succeeded are sometimes aborted conservatively. Applications using `SERIALIZABLE` must retry on serialization errors.

```sql
-- Monitor serialization failure rate
SELECT
    datname,
    conflicts AS serialization_failures,
    deadlocks
FROM  pg_stat_database
WHERE datname = current_database();
```

> **Takeaway**: Snapshot isolation does not prevent write skew. SSI detects read-write dependency cycles and aborts one transaction to prevent it. Applications using `SERIALIZABLE` must retry on serialization errors. SSI has better read throughput than 2PL because reads do not acquire locks.

---

## Deadlocks: Detection, Prevention, and Handling

A deadlock occurs when two or more transactions are each waiting for a lock held by the other. Neither can proceed. Neither will release.

```
Step 1: Tx A  → acquires lock on account id=1   ✓
Step 2: Tx B  → acquires lock on account id=2   ✓
Step 3: Tx A  → wants lock on account id=2      → WAITS for Tx B
Step 4: Tx B  → wants lock on account id=1      → WAITS for Tx A

Neither transaction will ever proceed on its own.
```

### How PostgreSQL Detects Deadlocks

PostgreSQL maintains a **wait-for graph** — a directed graph where an edge A → B means "transaction A is waiting for a lock held by B." A deadlock exists when this graph contains a cycle.

PostgreSQL does not check continuously — that would be expensive. When a transaction has been waiting longer than `deadlock_timeout` (default: 1 second), PostgreSQL runs the cycle detection algorithm. If a cycle is found, it aborts one transaction and returns:

```
ERROR:  deadlock detected
DETAIL: Process 12345 waits for ShareLock on transaction 67890;
        blocked by process 11111.
        Process 11111 waits for ShareLock on transaction 12345;
        blocked by process 12345.
HINT:   See server log for query details.
```

The aborted transaction gets this error. The other transaction is immediately unblocked and continues. Build retry logic into any code that uses explicit locking.

### Prevention: Consistent Lock Ordering

The most reliable prevention technique is **consistent lock ordering** — always acquire locks in the same global order. If every transaction locks row A before row B before row C, no circular wait is ever possible.

```
Inconsistent ordering causes deadlocks:

  Step 1: Tx A  → locks account id=1, then wants id=2
  Step 2: Tx B  → locks account id=2, then wants id=1
  → Deadlock

Consistent ordering prevents deadlocks:

  Step 1: Tx A  → locks LEAST(1,2)=1 first, then id=2
  Step 2: Tx B  → locks LEAST(2,1)=1 first (waits for A), then id=2
  → No deadlock. Tx B simply waits.
```

**PostgreSQL example — deadlock-safe transfer function:**

```sql
CREATE OR REPLACE FUNCTION transfer(
    from_id INT,
    to_id   INT,
    amount  NUMERIC
) RETURNS VOID AS $$
DECLARE
    first_id  INT := LEAST(from_id, to_id);
    second_id INT := GREATEST(from_id, to_id);
BEGIN
    -- Always lock the lower ID first, regardless of transfer direction.
    -- transfer(1→2) and transfer(2→1) both lock id=1 first.
    PERFORM 1 FROM accounts WHERE id = first_id  FOR UPDATE;
    PERFORM 1 FROM accounts WHERE id = second_id FOR UPDATE;

    UPDATE accounts SET balance = balance - amount WHERE id = from_id;
    UPDATE accounts SET balance = balance + amount WHERE id = to_id;
END;
$$ LANGUAGE plpgsql;
```

`LEAST()` and `GREATEST()` guarantee the same locking order for any pair of accounts regardless of transfer direction. Concurrent `transfer(1→2)` and `transfer(2→1)` both lock id=1 first — one waits, but they never deadlock.

### Lock Timeouts

Set explicit time limits rather than waiting indefinitely:

```sql
-- Fail immediately if the lock cannot be acquired
SELECT * FROM orders WHERE id = 42 FOR UPDATE NOWAIT;
-- ERROR: could not obtain lock on row in relation "orders"

-- Wait up to 3 seconds, then fail
SET lock_timeout = '3s';
SELECT * FROM orders WHERE id = 42 FOR UPDATE;
-- ERROR: canceling statement due to lock timeout  (if not acquired in 3s)

-- Kill any session that has been idle in a transaction for more than 30 seconds
-- idle-in-transaction sessions hold locks while doing nothing
SET idle_in_transaction_session_timeout = '30s';
```

`idle in transaction` sessions are the most common source of unexplained contention in production. A transaction started, acquired locks, and the application forgot to commit — or the connection went idle. The locks are still held. Every transaction that needs those rows is queued behind them.

### Observing Deadlocks and Lock Waits in Production

Enable lock wait logging in `postgresql.conf`:

```
log_lock_waits = on    -- log any lock wait exceeding deadlock_timeout
deadlock_timeout = 1s  -- also the threshold for deadlock detection
```

Any transaction waiting more than 1 second is logged — you see contention before it escalates to deadlocks.

```sql
-- Find transactions currently waiting for locks
SELECT
    pid,
    now() - query_start   AS wait_duration,
    wait_event_type,
    wait_event,
    state,
    query
FROM  pg_stat_activity
WHERE wait_event_type = 'Lock'
ORDER BY wait_duration DESC;

-- Find idle-in-transaction sessions (holding locks while doing nothing)
SELECT
    pid,
    now() - state_change  AS idle_duration,
    state,
    query
FROM  pg_stat_activity
WHERE state = 'idle in transaction'
ORDER BY idle_duration DESC;
```

> **Takeaway**: Deadlocks are detected by PostgreSQL's wait-for graph after `deadlock_timeout` (1s). One transaction is aborted — build retry logic. Prevent with consistent lock ordering using `LEAST`/`GREATEST`. Use `lock_timeout` to fail fast. Set `idle_in_transaction_session_timeout` to kill sessions that hold locks while doing nothing. Enable `log_lock_waits` to catch contention early.

---

## Putting It Together: Choosing the Right Approach

**Financial transfers — preventing lost updates:**

Use `SELECT FOR UPDATE` with consistent lock ordering.

```sql
BEGIN;
SELECT balance FROM accounts WHERE id = LEAST($1, $2)    FOR UPDATE;
SELECT balance FROM accounts WHERE id = GREATEST($1, $2) FOR UPDATE;
UPDATE accounts SET balance = balance - $3 WHERE id = $1;
UPDATE accounts SET balance = balance + $3 WHERE id = $2;
COMMIT;
```

**Job queues — distributing work without contention:**

Use `FOR UPDATE SKIP LOCKED`. Multiple workers dequeue simultaneously without blocking each other.

```sql
BEGIN;
SELECT id, payload
FROM   jobs
WHERE  status = 'pending'
ORDER  BY priority DESC, created_at ASC
FOR    UPDATE SKIP LOCKED
LIMIT  1;
UPDATE jobs SET status = 'done' WHERE id = $1;
COMMIT;
```

**Read-heavy workloads — maximum concurrency:**

Use the default `READ COMMITTED`. MVCC ensures readers and writers never block each other.

**Consistent reports and analytics:**

Use `REPEATABLE READ`. The snapshot is fixed at transaction start — all queries in the report see the same consistent state.

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT SUM(balance)      FROM accounts;
SELECT COUNT(*)          FROM orders WHERE status = 'completed';
SELECT AVG(order_value)  FROM orders WHERE created_at > now() - interval '30 days';
-- All three queries reflect the exact same database state
COMMIT;
```

**Multi-row invariants that must never be violated:**

Use `SERIALIZABLE` and build retry logic for serialization failures.

---

## Key Takeaways

**The four anomalies** are dirty reads, non-repeatable reads, phantom reads, and lost updates. The lost update is the most dangerous — no error, silently wrong data.

**Pessimistic control** locks before acting — safe for high-contention data. **Optimistic control** acts first, validates at commit with version columns — efficient when conflicts are rare.

**Shared locks** allow concurrent reads. **Exclusive locks** block all other access. `FOR UPDATE` acquires an exclusive row lock and holds it until commit.

**`ACCESS EXCLUSIVE`** — acquired by `ALTER TABLE`, `DROP TABLE`, `TRUNCATE` — blocks all traffic including reads. Plan DDL migrations on busy tables carefully.

**`FOR UPDATE SKIP LOCKED`** skips locked rows instead of waiting — essential for job queues with multiple concurrent consumers.

**Two-Phase Locking** separates lock acquisition from release. Strict 2PL holds all locks until commit, preventing cascading aborts. Deadlocks are an inherent consequence.

**MVCC** keeps multiple row versions. Readers see a snapshot of the past. They never block writers and writers never block them. Dead tuples accumulate — monitor `pg_stat_user_tables` and tune autovacuum.

**`READ COMMITTED`** refreshes the snapshot per statement. **`REPEATABLE READ`** fixes the snapshot for the transaction. PostgreSQL's `REPEATABLE READ` also prevents phantom reads.

**Write skew** — two transactions reading overlapping data and writing different rows — is not caught by snapshot isolation. **`SERIALIZABLE`** (SSI) detects read-write dependency cycles and aborts one transaction.

**Deadlocks** are detected by PostgreSQL's wait-for graph after `deadlock_timeout` (1s). Prevent with consistent lock ordering. Use `lock_timeout` to fail fast.

**`idle in transaction`** sessions hold locks while doing nothing — the most common source of unexplained production contention. Set `idle_in_transaction_session_timeout` to kill them automatically.

**Monitor** with `pg_locks`, `pg_stat_activity`, and `pg_stat_database`. Enable `log_lock_waits`. The three signals: long lock waits, high dead tuple counts, frequent serialization failures.
