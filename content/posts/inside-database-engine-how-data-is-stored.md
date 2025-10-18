---
title: "How Databases Actually Store Data: Pages, Tuples, and the Architecture That Matters"
date: "2025-10-20"
readTime: "17 min read"
---

There's a gap between understanding how SQL works and understanding how databases actually store bits on disk. Most developers never cross that gap. Their databases just work until they don't, and then they're stuck guessing at why performance degraded or why they're burning through disk space.

I'm going to walk you through the actual storage layer. Not the theoretical version. The version that explains why your database behaves the way it does in production, why certain operations are fast and others are slow, and what you can actually do about it.

## Why Storage Architecture Matters

Before we get into the details, let's establish why you should care about how a database stores data. The fundamental constraint in any system is disk I/O. Your CPU can execute billions of operations per second. A modern SSD can do about 100,000 to 1,000,000 IOPS. Every disk access you make is buying milliseconds when your users expect microseconds. Everything downstream—indexing strategies, query optimization, replication design—is built around minimizing disk I/O.

The storage layer determines whether your database can handle millions of writes per second or if it'll start falling over after a few thousand. It determines whether your read queries hit disk once or five times. It determines whether your hardware is working hard or just moving data around inefficiently.

Most importantly: storage architecture is a fundamental choice that's hard to change. PostgreSQL uses one design, RocksDB uses a completely different one. Knowing which is which explains why you might pick one over the other.

---

## The Heap: Storing Rows in Pages

Let's start simple. A database table is stored on disk, and the disk is organized into pages. A page is the smallest unit of I/O your database does. When you read a single row from a table, you're probably reading an entire page (8KB in PostgreSQL, 16KB in MySQL). When you write a single row, you're writing an entire page.

This is why page size matters. It's a tradeoff between efficiency of sequential access (bigger pages mean fewer I/O operations) and memory overhead (you load 16KB into memory just to read one row). Most databases default to 8KB or 16KB and rarely change this. PostgreSQL lets you configure it at compile time, so it's technically 8KB by default but most production setups don't change it. MySQL's InnoDB defaults to 16KB, and you can configure it per instance in the config. SQLite defaults to 4KB but also supports other sizes.

The page size also affects your working set in the buffer pool. If your buffer pool is 10GB and you have 8KB pages, you can cache roughly 1.3 million pages. With 16KB pages, it's 650,000 pages. That difference matters for workloads where you're scanning large tables repeatedly—smaller pages fit more into memory for the same amount of RAM.

Inside each page, you're not just dumping rows sequentially. That would be a disaster. Imagine you have a page with three rows. You delete the middle one. Now you have a gap. You can't just move the third row forward—that would break any index entries that point to its physical location. You waste space, or you spend CPU cycles rewriting everything. Both options suck.

In MySQL/InnoDB specifically, when you delete a row, the space is marked as free but remains on the page. Over time, as you delete rows and insert smaller rows, the page becomes increasingly sparse. This is called fragmentation. When you run OPTIMIZE TABLE, InnoDB rebuilds the entire table and index, which essentially compacts everything and reclaims that wasted space. The downside is it locks the table for writes during the operation.

PostgreSQL handles this differently with VACUUM. When you delete a row, it's marked with XMAX (the transaction ID that deleted it), but the physical space remains on the page until VACUUM runs. VACUUM is less aggressive than OPTIMIZE TABLE—it runs incrementally and doesn't require a full lock—but it also doesn't reclaim space as aggressively.

This problem is why databases use slotted pages.

---

## Slotted Pages: How PostgreSQL and MySQL Actually Organize Data

A slotted page looks like this on disk:

```ts
[Page Header]
[                    Free Space                    ]
[Slot Directory Growing Upward: [Slot 3][Slot 2][Slot 1]]
```

The page header contains metadata about the page. In PostgreSQL, you've got the LSN (for recovery), checksums (for detecting corruption), and two critical pointers: one pointing to the end of the slot directory, one pointing to the start of free space. The size is small, around 20 bytes, and it's read on every access.

The slot directory is the innovation that solves the fragmentation problem. Each slot contains an offset and a size. When you want row 5 on a page, you don't scan linearly. You go to slot 5, read the offset (say, 2048), jump to position 2048, and read your row. It's a level of indirection that buys you flexibility.

Here's why that matters. Suppose you have this page:

```ts
Slot 1: offset=100, size=50   -> Row 1 is 50 bytes starting at position 100
Slot 2: offset=160, size=40   -> Row 2 is 40 bytes starting at position 160
Slot 3: offset=210, size=60   -> Row 3 is 60 bytes starting at position 210
```

Now you delete row 2. What happens? PostgreSQL marks the slot as dead (sets the size to 0) and leaves the data where it is. The slot directory still says "this was row 2." Index entries that pointed to (page_id, slot_2) still work—they just get told the row is dead.

When you insert row 4 (35 bytes), PostgreSQL can reuse the space where row 2 was:

```ts
Slot 1: offset=100, size=50
Slot 2: DEAD
Slot 3: offset=210, size=60
Slot 4: offset=160, size=35   -> Reuses row 2's old space
```

This is the entire point. The slot directory lets you move data around on the page without invalidating external references. Indexes point to slot numbers, not to physical offsets. As long as the slot number stays the same, everything works.

---

## Tuple Headers and MVCC

Each row has its own header. In PostgreSQL, this is called the tuple header and it's about 6 to 27 bytes depending on how many nullable columns you have. It contains the tuple ID (t_ctid), which tells you the current location of this tuple. It also contains visibility information for MVCC (Multi-Version Concurrency Control).

MVCC is why the tuple header exists. When you update a row in PostgreSQL, it doesn't modify the row in place. It creates a new version of the row. The old version is marked with information saying "this was live until transaction X committed." The new version says "this became live when transaction Y committed." The tuple header is where this information lives.

This is why PostgreSQL can have concurrent reads and writes without locking each other out—they can be reading and modifying different versions of the same row simultaneously.

The tuple header also points to the previous version of the row (on UPDATE) and contains the transaction IDs that can see this version. This metadata is small but essential, and it exists on every single row.

---

## When Rows Don't Fit: TOAST

What happens when a single row is larger than a page? PostgreSQL has TOAST—The Oversized-Attribute Storage Technique. It's not a clever acronym, it's exactly what it sounds like.

For columns with large values (text, JSONB, arrays), PostgreSQL compresses them and stores them in a separate TOAST table. The main row stores a pointer. When you query, if you need that column, PostgreSQL follows the pointer and retrieves it. If you don't need it (say, you're selecting just the ID and name), you never pay the cost of reading the large column.

This keeps pages compact and sequential scanning fast. It's a clever solution that most developers never encounter because they don't often store 50MB JSONB objects in database columns. But when someone does, TOAST makes sure it doesn't destroy table scan performance.

## The Problem Slotted Pages Created

Slotted pages are elegant. They solve the fragmentation problem. But they created a new one: write amplification.

When you update a single byte in a row, here's what actually happens:

1. The database finds the page containing the row
2. Loads that page into memory from disk (8KB read)
3. Modifies the byte in memory
4. Updates the page header and MVCC metadata
5. Writes the entire page back to disk (8KB write)

Now multiply this by indexes. If the row is in a B-tree index and you updated an indexed column, the index also needs to update. Same process: read page, modify, write page back. You've turned a single byte change into multiple random disk I/O operations.

In write-heavy workloads (time-series data, event logging, analytics ingestion), this adds up. You're doing random I/O instead of sequential I/O, which is the worst case for disk performance. Modern SSDs mask some of this through caching and parallelism, but the fundamental inefficiency remains.

Databases using slotted pages work around this with aggressive caching (large buffer pools) and write-ahead logging (WAL) that batches writes sequentially. But they're fundamentally fighting physics.

This is where LSM trees come in.

## LSM Trees: A Different Philosophy

An LSM Tree (Log-Structured Merge Tree) doesn't try to maintain sorted data in place. Instead, it appends everything to a sequential log. This is a completely different design philosophy with completely different tradeoffs.

Think about it this way. When you insert a row into an LSM tree, it goes into memory (a structure called the MemTable) and is immediately written to a sequential log on disk. Sequential writes are orders of magnitude faster than random writes. Even on mechanical disks, sequential I/O destroys random I/O for throughput.

Here's the architecture:

When you write a key-value pair, it goes to the MemTable (usually a red-black tree or skip list kept in RAM). It's also written to a WAL (write-ahead log) on disk. The MemTable keeps growing.

When the MemTable reaches a threshold (typically 64MB or 128MB, configurable), it's flushed to disk as an SSTable (Sorted String Table). Now you have an immutable file on disk with that data.

But you can't have millions of SSTables lying around. That would make reads impossibly slow. So the database runs compaction in the background.

Compaction merges SSTables from lower levels into higher levels. You're reading from the lower level, sorting/merging data, and writing to the higher level. It's expensive. You're touching the same data multiple times. But it happens in the background, not during user requests.

Let me walk through what this looks like in practice with RocksDB (which popularized this design):

Level 0 might hold SSTables that were just flushed from the MemTable. They're not sorted relative to each other—different SSTables might have overlapping keys. Level 0 can hold maybe 4 SSTables before it compacts. The threshold is configurable (level0_file_num_compaction_trigger in RocksDB).

Level 1 holds SSTables that have been merged so their key ranges don't overlap. Level 1 might be 10x larger than Level 0 (also configurable with max_bytes_for_level_base). When Level 1 gets too full, it compacts with Level 2. This ratio is called the multiplier, and changing it dramatically changes write amplification.

Each level is roughly 10x larger than the previous level. At the highest level (maybe Level 6 or 7), you have gigabytes of data, all sorted, with zero overlap. The total number of levels is log base 10 of (total data size).

When you read a key at Level 6, you've only paid for reading one SSTable. When you write that key initially, it went through Levels 0-6, but each write happened sequentially in the background.

---

## Understanding SSTable Structure

An SSTable isn't just a dump of key-value pairs. It's organized into blocks:

Each block is maybe 4KB to 64KB (typically 4KB in RocksDB, configurable with block_size) and is independently compressed (with Snappy, LZ4, or zstd). The point of independent blocks is you can decompress just the blocks you need. If you're searching for a specific key, you don't decompress the entire SSTable.

Within each block, the keys are sorted. The SSTable also has a block index that tells you the range of keys in each block, so you can do binary search on blocks before decompressing.

The structure looks roughly like:

```ts
[Block 1: compressed data]
[Block 2: compressed data]
...
[Block N: compressed data]
[Block Index: [Key1→Block1Offset, Key2→Block2Offset, ...]]
[Metadata Footer: compression type, number of entries, creation time, ...]
```

Then there's the metadata block at the end of the SSTable. It contains the number of entries, compression settings, and critically, a Bloom filter.

A Bloom filter is a probabilistic data structure. It answers one question: is this key definitely NOT in this SSTable, or might it be in this SSTable? It has false positives (might say a key exists when it doesn't) but never false negatives (never says a key doesn't exist when it does).

The Bloom filter is usually about 10 bits per entry (configurable). For an SSTable with 1 million entries, that's roughly 1.25MB for the Bloom filter. The false positive rate is typically around 1%, meaning 1% of negative lookups will incorrectly suggest the key might exist.

This matters for reads. When you look up a key, you're checking multiple levels. For levels you're not sure about, you check their Bloom filter first. If it says "not here," you skip that SSTable entirely. This dramatically speeds up read misses, which is important because misses are common in databases.

---

## Reading from an LSM Tree

Reading is where LSM trees get less pretty than B-trees. To find a key, you have to check multiple places:

1. MemTable (fast, in-memory search using the red-black tree or skip list)
2. Level 0 SSTables (might have multiple, need to check them all or use Bloom filters)
3. Check Bloom filter for Level 1 (quick false-negative check)
4. If Bloom filter says "might exist," search Level 1 SSTable using binary search on blocks
5. Level 2 SSTables (and so on)

In the worst case, you're doing a few disk seeks. In practice, with Bloom filters and caching, it's usually one or two. Still slower than a B-tree read (one seek), but the difference is smaller than people think. Both are microseconds. The difference between 5 microseconds and 10 microseconds doesn't usually matter.

But here's where it gets tricky. If you have 7 levels of data, you might need to check the Bloom filter for each level before finding a missing key. That's multiple Bloom filter checks (fast, in memory) but ultimately confirming the key doesn't exist. Real reads often involve multiple Bloom filter checks, not just one disk seek.

What matters is write throughput, where LSM trees shine. And read latency consistency. A B-tree that has to do random I/O can have unpredictable latency. An LSM tree with careful compaction tuning is more predictable because the reads are mostly predictable once you understand the level structure.

---

## Compaction and Write Amplification

Here's the cost of LSM trees. All those SSTables being merged and compacted means data is being rewritten many times.

Suppose you insert a key-value pair. Here's what happens to it:

1. Written to MemTable and WAL (1x write to disk, but WAL is sequential)
2. MemTable flushed to Level 0 SSTable (1x write to disk, sequential)
3. Level 0 compacts into Level 1 (read from Level 0 + write to Level 1, roughly 2x write)
4. Level 1 compacts into Level 2 (read from Level 1 + write to Level 2, roughly 2x write)
5. And so on through 5 or 6 more levels

That single key-value pair has been written 10+ times before it settles at the highest level. This is called write amplification. For a typical LSM setup (10x size ratio between levels), you're looking at write amplification of 5-10x.

The formula is roughly: write_amplification ≈ (number_of_levels) \* (level_multiplier - 1). With 7 levels and 10x multiplier, you get roughly 60x theoretical write amplification. But in practice, it's lower because compactions don't always touch every level.

But here's the crucial point: these writes happen sequentially in the background. They're not random disk I/O during your critical path. You're trading background throughput for foreground latency. That's usually a good deal. A single foreground write is maybe 1KB, which goes to the MemTable and WAL sequentially. The background compaction re-reads and re-writes that data many times, but it's all happening sequentially and can be batched efficiently.

Different databases tune this differently. RocksDB and LevelDB use leveled compaction (each level is strictly sorted with no overlap). Cassandra uses tiered compaction (multiple SSTables accumulate at each level before compacting together). Each strategy changes the write amplification and read latency differently.

With leveled compaction, write amplification is lower and read performance is more predictable, but compaction is more frequent. With tiered compaction, write amplification is higher but compaction is less frequent, reducing CPU spikes.

In practice, production systems usually tune compaction to be "good enough" at both reads and writes. RocksDB's defaults are tuned for read/write balance. If you're write-heavy (like Kafka or event streaming), you might increase the level multiplier to 20 or 40 to reduce background compaction. If you're read-heavy, you might keep it at 10 or even lower.

---

## When Each One Wins

Slotted page B-trees (PostgreSQL, MySQL, SQLite):

These are brilliant for OLTP. You've got mixed reads and writes, you need complex indexes, you need to support transactions with rollback. The in-place updates work well when your working set fits in the buffer pool. Range queries are fast because the index is sorted and you can walk the B-tree leaf nodes linearly. The tradeoff is random I/O on writes, but good cache behavior and careful WAL tuning makes it work.

Most production OLTP databases use this design because the predictable read performance matters more than write throughput. A financial transaction system cares more about reading account balances consistently and quickly than about maximizing writes per second.

The overhead of MVCC and the tuple headers (24+ bytes per row) is worth it because you get consistent snapshots and no locks. When you need ACID guarantees, PostgreSQL and MySQL deliver that reliably.

But there's a ceiling. With mixed workloads, you're stuck with the random I/O problem. You can tune it—larger buffer pools, better indexes, careful query planning—but you can't escape it fundamentally.

LSM trees (RocksDB, Cassandra, LevelDB):

These are brilliant for write-heavy workloads and time-series data. Millions of writes per second. Data arriving in sorted order (timestamps). Reads are still fast, but not as predictable as B-trees. The background compaction can cause read/write spikes when a major compaction runs (especially with leveled compaction). But for throughput, they're unbeatable.

This is why every time-series database (InfluxDB, Prometheus, Cassandra, HBase) uses LSM trees under the hood. The write throughput is the main requirement, and the predictable read spikes during compaction are acceptable.

Time-series is the perfect workload for LSM trees because data arrives with monotonically increasing timestamps. You're always inserting at the end of the key range. You're rarely updating old data. The MemTable fills up with new data that's naturally sorted by time, then it flushes to Level 0. During compaction, you're mostly just reorganizing data that has no overlap in key ranges. This is the best-case scenario for LSM performance.

For analytics systems, LSM trees also work well because reads often scan large ranges (you're computing aggregates, not point lookups). Scanning a range in an LSM tree requires reading multiple levels, but you're reading sequentially through each level's SSTables. The multiple levels are actually fine for range scans—you're reading sorted data anyway.

The catch is point lookups on random keys. If you're doing millions of random key lookups (like a cache-like workload), an LSM tree might have more latency variability than a B-tree, but it's still in the microsecond range for in-cache hits and millisecond range for disk misses.

---

## What This Means for Operations

If you're running PostgreSQL, you need to understand slotted pages. Index maintenance, VACUUM to reclaim space, WAL tuning—all of this makes sense when you understand that you're managing random page writes.

Specifically, you need to monitor:

- Table and index bloat. Use tools like pgstattuple to check bloat percentage. If tables are more than 20% bloat, schedule VACUUM.
- Autovacuum settings. The default settings are conservative. In write-heavy tables, you might need aggressive autovacuum settings (lower delay_cost, lower sleep time).
- WAL archiving and replication lag. WAL is your durability guarantee, so understanding WAL generation and flush rates matters.
- Buffer pool hit ratio. If your working set doesn't fit in shared_buffers, you're doing unnecessary disk I/O. Monitor pg_stat_statements.blks_hit / (blks_hit + blks_read).

If you're running a RocksDB-based system, you need to understand compaction. Tuning compaction strategy, monitoring write amplification, understanding the tradeoff between read latency and background write throughput. That's where your knobs are.

Specifically:

- Compaction stats. RocksDB logs compaction activity. Monitor compaction time, size, and frequency. If compaction is happening constantly, increase the level multiplier. If compaction is rare but causes latency spikes, tune the speed of compaction.
- Write stalls. RocksDB can throttle writes if too many SSTables accumulate at Level 0 (memtable_factory::WriteBufferManager). You'll see write stalls in the logs.
- Read latency percentiles. Monitor p99 and p999 latencies separately from average. LSM trees can have long-tail latencies during compaction even if average latency is good.
- Bloom filter effectiveness. If Bloom filter false positive rate is high, you're checking more SSTables than necessary. Increase bloom_bits_per_key.

And if you're building something, understanding these architectures should drive your decision. Write-heavy time-series data? LSM tree. OLTP with mixed access patterns? Slotted pages. Simple embedded database? Probably B-tree. The architecture determines what tradeoffs you're making.

---

## The Hybrid Approach

Some databases try to be both. MySQL's InnoDB is primarily B-tree based with slotted pages, but uses a more sophisticated WAL that batches writes. The log buffer accumulates changes from multiple pages, then a single flush writes the entire buffer sequentially. This gives some of the write efficiency of LSM trees while keeping read performance of B-trees.

RocksDB-based systems like TiDB add distributed consistency on top. TiDB uses RocksDB (LSM tree) for the local storage layer but coordinates through Raft for replication. This is more of an architecture choice than a storage optimization, but it works because the underlying storage layer is proven.

CockroachDB uses RocksDB underneath but maintains sorted ranges across nodes. It's an LSM tree at the storage layer but presents B-tree-like properties to the user through distributed logic. When you query a range in CockroachDB, the coordinator knows which nodes hold which key ranges, so it can efficiently route the query even though each node uses LSM trees internally.

MongoDB's WiredTiger storage engine uses both B-trees and LSM tree concepts. It has a write-ahead log that's append-only, then periodically applies those writes to B-tree pages. The pages themselves use a different internal structure than traditional B-trees (called a "page format" that's optimized for compression and update-in-place). This is a hybrid that tries to get good read performance with better write throughput than pure B-trees.

---

## Why This Matters Now

These design choices were made decades ago (B-trees in the 70s, LSM trees in the 90s). But hardware has changed. Modern SSDs handle random I/O better than mechanical disks. CPU caches are larger. Memory is cheaper. Yet the fundamental architecture decisions still hold up.

If anything, they matter more now. Distributed systems depend on these architectures being well-understood and well-tuned. Cloud databases are built on top of them. When you're paying for both compute and storage by the byte, understanding this layer directly impacts your bill.

The move to cloud storage (S3, GCS) is changing things too. Some databases now use tiered storage—hot data in fast NVMe, cold data in cloud object storage. This changes the calculus. Sequential I/O to object storage can be fast if you batch requests, but random I/O is still bad. This is pushing databases back toward LSM-tree-like designs even for OLTP workloads.

Newer databases like DuckDB (analytical) and SQLite with new optimizations are experimenting with compressed pages and columnar storage. These represent another evolution of storage architecture, optimizing for specific workload patterns rather than trying to be general-purpose.

If your database is slow, the answer is often here. In how the data is physically laid out. In whether you're doing random or sequential I/O. In whether you understand what your storage layer is actually doing. In whether the hardware matches the workload or whether you're fighting the architecture.

That understanding is what separates people who can debug database performance from people who just buy more servers and hope. that tells you the range of keys in each block, so you can do binary search on blocks before decompressing.

Then there's the metadata block at the end of the SSTable. It contains the number of entries, compression settings, and critically, a Bloom filter.

A Bloom filter is a probabilistic data structure. It answers one question: is this key definitely NOT in this SSTable, or might it be in this SSTable? It has false positives (might say a key exists when it doesn't) but never false negatives (never says a key doesn't exist when it does).

This matters for reads. When you look up a key, you're checking multiple levels. For levels you're not sure about, you check their Bloom filter first. If it says "not here," you skip that SSTable entirely. This dramatically speeds up read misses.

## Reading from an LSM Tree

Reading is where LSM trees get less pretty than B-trees. To find a key, you have to check multiple places:

1. MemTable (fast, in-memory)
2. Level 0 SSTables (might have multiple)
3. Level 1 SSTables (use Bloom filter to skip)
4. Level 2 SSTables (and so on)

In the worst case, you're doing a few disk seeks. In practice, with Bloom filters and caching, it's usually one or two. Still slower than a B-tree read (one seek), but the difference is smaller than people think. Both are microseconds. The difference between 5 microseconds and 10 microseconds doesn't usually matter.

What matters is write throughput, where LSM trees shine. And read latency consistency. A B-tree that has to do random I/O can have unpredictable latency. An LSM tree with careful compaction tuning is more predictable.

## Compaction and Write Amplification

Here's the cost of LSM trees. All those SSTables being merged and compacted means data is being rewritten many times.

Suppose you insert a key-value pair. Here's what happens to it:

1. Written to MemTable and WAL (1x write)
2. MemTable flushed to Level 0 SSTable (1x write)
3. Level 0 compacts into Level 1 (read + write, roughly 2x)
4. Level 1 compacts into Level 2 (read + write, roughly 2x)
5. And so on through 5 or 6 more levels

That single key-value pair has been written 10+ times before it settles at the highest level. This is called write amplification. For a typical LSM setup (10x size ratio between levels), you're looking at write amplification of 5-10x.

But here's the crucial point: these writes happen sequentially in the background. They're not random disk I/O during your critical path. You're trading background throughput for foreground latency. That's usually a good deal.

Different databases tune this differently. RocksDB and LevelDB use leveled compaction (each level is strictly sorted with no overlap). Cassandra uses tiered compaction (multiple SSTables accumulate at each level before compacting). Each strategy changes the write amplification and read latency differently.

## When Each One Wins

Slotted page B-trees (PostgreSQL, MySQL, SQLite):

These are brilliant for OLTP. You've got mixed reads and writes, you need complex indexes, you need to support transactions with rollback. The in-place updates work well. Range queries are fast. The tradeoff is random I/O on writes, but good cache behavior and careful WAL tuning makes it work. Most production OLTP databases use this design.

LSM trees (RocksDB, Cassandra, LevelDB):

These are brilliant for write-heavy workloads and time-series data. Millions of writes per second. Data arriving in sorted order (timestamps). Reads are still fast, but not as predictable as B-trees. The background compaction can cause read/write spikes. But for throughput, they're unbeatable. This is why every time-series database uses LSM trees under the hood.

## What This Means for Operations

If you're running PostgreSQL, you need to understand slotted pages. Index maintenance, VACUUM to reclaim space, WAL tuning—all of this makes sense when you understand that you're managing random page writes.

If you're running a RocksDB-based system, you need to understand compaction. Tuning compaction strategy, monitoring write amplification, understanding the tradeoff between read latency and background write throughput. That's where your knobs are.

And if you're building something, understanding these architectures should drive your decision. Write-heavy time-series data? LSM tree. OLTP with mixed access patterns? Slotted pages. Simple embedded database? Probably B-tree. The architecture determines what tradeoffs you're making.

## The Hybrid Approach

Some databases try to be both. MySQL's InnoDB is primarily B-tree based but uses a more sophisticated WAL that batches writes. RocksDB-based systems like TiDB add distributed consistency on top. These work, but they're still making fundamental architecture choices. You can't escape the tradeoff between random I/O and compaction overhead.

## Why This Matters Now

These design choices were made decades ago (B-trees in the 70s, LSM trees in the 90s). But hardware has changed. Modern SSDs handle random I/O better than mechanical disks. CPU caches are larger. Memory is cheaper. Yet the fundamental architecture decisions still hold up.

If anything, they matter more now. Distributed systems depend on these architectures being well-understood and well-tuned. Cloud databases are built on top of them. When you're paying for both compute and storage by the byte, understanding this layer directly impacts your bill.

If your database is slow, the answer is often here. In how the data is physically laid out. In whether you're doing random or sequential I/O. In whether you understand what your storage layer is actually doing.

That understanding is what separates people who can debug database performance from people who just buy more servers and hope.
