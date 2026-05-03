---
title: "Implementing a Write-Ahead Log in Go"
date: "2026-5-4"
readTime: "15 min read"
category: "Database Internals"
---

## Implementing a Write-Ahead Log in Go

A Write-Ahead Log is the mechanism behind the D in ACID. Before any mutation reaches your data files, a record describing that mutation is written and fsynced to the log. On crash, the log is replayed. This is how PostgreSQL, SQLite, RocksDB, and virtually every storage engine that claims durability actually deliver it.

This post implements a WAL in Go from the ground up: binary record format, CRC32 integrity checking, fsync semantics, crash recovery, and log rotation. A key-value store sits on top to prove it works end to end.

---

## The OS Storage Stack and Why It Matters

Understanding what `write()` actually does is a prerequisite. Most engineers get this wrong.

When you call `os.File.Write()` in Go, the kernel copies your bytes into the **page cache** — a region of RAM the kernel uses to buffer disk I/O — and returns immediately. The data is not on disk. The kernel will flush dirty pages to disk asynchronously via writeback, on its own schedule. Between your `write()` returning and writeback completing, a power loss or kernel panic loses your data silently.

```
write()  →  page cache (RAM)  →  [writeback, async]  →  disk
```

`fsync(fd)` tells the kernel: flush all dirty pages for this file descriptor to the storage device, then wait for the device to confirm the data has reached stable storage. It is expensive — 1–10ms on SSDs — because it crosses the PCIe bus and waits for the device controller to respond.

There is also a second level: **disk write buffers**. Modern drives have volatile write caches that absorb bursts of writes and reorder them for sequential throughput. `fsync` drains this buffer too, issuing a FLUSH CACHE command to the device. Without it, the kernel's page cache is flushed but data can still be lost if the drive loses power before draining its own buffer. This is why databases on VMs that virtualize disk I/O have to verify that the hypervisor propagates fsync to physical media.

`fdatasync()` is `fsync()` minus metadata (atime, mtime). For WAL writes, `fdatasync()` is sufficient and marginally faster.

**The durability contract:**

```
1. encode record
2. write() to log file
3. fdatasync() log file      ← must complete before step 4
4. acknowledge commit to caller
```

Skip step 3 and you have no durability guarantee regardless of everything else.

---

## Record Format

Each WAL record has a fixed-size header followed by a variable-length payload.

```
┌──────────┬────────┬──────────┬────────────┬──────────────────┐
│ LSN      │ Type   │ CRC32    │ Length     │ Payload          │
│ uint64   │ uint8  │ uint32   │ uint32     │ [Length]byte     │
│ 8 bytes  │ 1 byte │ 4 bytes  │ 4 bytes    │ N bytes          │
└──────────┴────────┴──────────┴────────────┴──────────────────┘
           ←————— 17-byte fixed header ——————→
```

**LSN (Log Sequence Number)** — monotonically increasing uint64. We set it to the byte offset of the record in the log file. This makes seeking to a specific LSN an O(1) `Seek()` call — no scanning required. PostgreSQL uses the same design.

**Type** — uint8 identifying the operation: Write, Delete, or Commit.

**CRC32** — Castagnoli checksum of the payload bytes. On read, we recompute and compare. A mismatch means the record is corrupt — most likely a partial write from a crash. We stop reading and truncate the log at that point. The Castagnoli polynomial (used by ext4, iSCSI, PostgreSQL) has better burst-error detection than the IEEE polynomial for payloads under 32KB.

**Length** — uint32 byte count of the payload. Lets us read the exact payload size in one call without scanning for a delimiter.

All multi-byte fields are encoded **little-endian** — least significant byte first. x86 and ARM are both little-endian natively, so no byte-swapping occurs at runtime. The choice of endianness is arbitrary; consistency is what matters.

---

## Implementation

### Record Encoding and Decoding

```go
// wal/record.go

package wal

import (
	"encoding/binary"
	"fmt"
	"hash/crc32"
	"io"
)

const (
	TypeWrite  uint8 = 1
	TypeDelete uint8 = 2
	TypeCommit uint8 = 3

	// headerSize is the fixed byte size of every record header.
	// Changing this breaks all existing log files — treat it as a format version.
	// LSN(8) + Type(1) + CRC32(4) + PayloadLength(4) = 17
	headerSize = 17
)

// castagnoli is computed once at init time and reused across all checksum calls.
// CRC32 with this polynomial runs at memory bandwidth speed on x86 via SSE4.2.
var castagnoli = crc32.MakeTable(crc32.Castagnoli)

// Record is the in-memory representation of a WAL entry.
// It is never persisted in this form — always round-trips through encode/decode.
type Record struct {
	LSN     uint64
	Type    uint8
	Payload []byte
}

// encode serializes r into the binary wire format.
// It allocates exactly headerSize + len(r.Payload) bytes — no extra allocation.
func encode(r Record) []byte {
	buf := make([]byte, headerSize+len(r.Payload))

	binary.LittleEndian.PutUint64(buf[0:8], r.LSN)
	buf[8] = r.Type
	binary.LittleEndian.PutUint32(buf[9:13], crc32.Checksum(r.Payload, castagnoli))
	binary.LittleEndian.PutUint32(buf[13:17], uint32(len(r.Payload)))
	copy(buf[17:], r.Payload)

	return buf
}

// decode reads exactly one record from r.
// It returns io.EOF if the reader is exhausted before reading any bytes.
// It returns a non-nil error (not io.EOF) if the header is read but the
// record is corrupt — this is the crash-truncation case.
func decode(r io.Reader) (Record, error) {
	header := make([]byte, headerSize)
	_, err := io.ReadFull(r, header)
	if err != nil {
		// io.EOF here means the reader was empty — clean end of log.
		// io.ErrUnexpectedEOF means we read some bytes but not a full header
		// — this is a partial write, treat it as corruption.
		if err == io.EOF {
			return Record{}, io.EOF
		}
		return Record{}, fmt.Errorf("truncated header: %w", err)
	}

	rec := Record{
		LSN:  binary.LittleEndian.Uint64(header[0:8]),
		Type: header[8],
	}
	storedChecksum := binary.LittleEndian.Uint32(header[9:13])
	payloadLen := binary.LittleEndian.Uint32(header[13:17])

	rec.Payload = make([]byte, payloadLen)
	if _, err := io.ReadFull(r, rec.Payload); err != nil {
		return Record{}, fmt.Errorf("truncated payload at LSN %d: %w", rec.LSN, err)
	}

	// Verify integrity. A mismatch here almost always means the process
	// crashed between writing the header and writing the full payload,
	// leaving a partial record at the tail of the log.
	computed := crc32.Checksum(rec.Payload, castagnoli)
	if computed != storedChecksum {
		return Record{}, fmt.Errorf("checksum mismatch at LSN %d: stored=%d computed=%d",
			rec.LSN, storedChecksum, computed)
	}

	return rec, nil
}
```

### The WAL

```go
// wal/wal.go

package wal

import (
	"bufio"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sync"
)

const (
	// maxSegmentSize is the maximum byte size of a single log segment file
	// before rotation. 64MB matches PostgreSQL's default wal_segment_size.
	// Smaller segments mean more files but faster deletion of old log data.
	maxSegmentSize = 64 * 1024 * 1024 // 64MB

	// bufferSize is the size of the write buffer in front of the log file.
	// Writes smaller than this are buffered in memory and flushed together,
	// reducing the number of write() syscalls. The buffer is always flushed
	// before fsync — fsync on an unflushed buffer only syncs what the kernel
	// has seen, not what is still in userspace memory.
	bufferSize = 4 * 1024 // 4KB
)

// WAL is a write-ahead log. It is safe for concurrent use.
//
// A WAL is implemented as a sequence of segment files named by their starting
// LSN: 0000000000000000.log, 0000000000010000.log, etc.
// Only the current (last) segment is open for writing.
// All segments are read during recovery.
type WAL struct {
	mu      sync.Mutex
	dir     string        // directory containing segment files
	file    *os.File      // current segment file, open for writing
	buf     *bufio.Writer // write buffer in front of file
	nextLSN uint64        // LSN to assign to the next record
	size    int64         // current byte size of the active segment
}

// Open opens a WAL rooted at dir, creating it if it does not exist.
// It replays any existing segments to restore nextLSN.
// Call Recover() separately if you need the replayed records.
func Open(dir string) (*WAL, error) {
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("create wal dir: %w", err)
	}

	w := &WAL{dir: dir}

	// Scan existing segments to find the highest LSN written so far.
	// This positions nextLSN correctly so new records do not reuse old LSNs.
	if err := w.initLSN(); err != nil {
		return nil, err
	}

	// Open (or create) the active segment file.
	if err := w.openSegment(); err != nil {
		return nil, err
	}

	return w, nil
}

// initLSN scans all segment files to determine the next LSN to use.
// It reads every record to find the highest LSN, then positions
// nextLSN one record past that.
func (w *WAL) initLSN() error {
	segments, err := filepath.Glob(filepath.Join(w.dir, "*.log"))
	if err != nil {
		return err
	}

	var maxLSN uint64
	for _, seg := range segments {
		f, err := os.Open(seg)
		if err != nil {
			return err
		}
		reader := bufio.NewReader(f)
		for {
			rec, err := decode(reader)
			if err != nil {
				break // EOF or corrupt tail — stop reading this segment
			}
			if rec.LSN > maxLSN {
				maxLSN = rec.LSN
			}
		}
		f.Close()
	}

	if len(segments) > 0 {
		// nextLSN must be beyond the last record we found.
		// We use the physical file size of the last segment as the next LSN,
		// so LSN == byte offset remains true for the new segment.
		last := segments[len(segments)-1]
		info, err := os.Stat(last)
		if err != nil {
			return err
		}
		w.nextLSN = uint64(info.Size())
		_ = maxLSN // maxLSN is used only for validation in a production system
	}

	return nil
}

// openSegment opens the current segment file for appending, creating it
// if it does not exist. The filename encodes the starting LSN so the
// file's position in the global log sequence is unambiguous.
func (w *WAL) openSegment() error {
	name := filepath.Join(w.dir, fmt.Sprintf("%016x.log", w.nextLSN))
	f, err := os.OpenFile(name, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0644)
	if err != nil {
		return fmt.Errorf("open segment %s: %w", name, err)
	}

	info, err := f.Stat()
	if err != nil {
		f.Close()
		return err
	}

	w.file = f
	w.buf = bufio.NewWriterSize(f, bufferSize)
	w.size = info.Size()
	return nil
}

// Write appends a record to the log and syncs it to disk.
//
// The sync happens unconditionally on every write. This is correct for
// single-record durability — every write is immediately durable.
// For higher throughput, group commit batches multiple writes before a
// single fsync. We implement the simple version here.
//
// Write is safe to call from multiple goroutines concurrently.
func (w *WAL) Write(recordType uint8, payload []byte) (uint64, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	lsn := w.nextLSN
	rec := Record{
		LSN:     lsn,
		Type:    recordType,
		Payload: payload,
	}

	encoded := encode(rec)

	// Write to the buffered writer. This may or may not issue a write()
	// syscall — the buffer absorbs small writes and flushes when full.
	if _, err := w.buf.Write(encoded); err != nil {
		return 0, fmt.Errorf("buffer write: %w", err)
	}

	// Flush the userspace buffer to the kernel's page cache.
	// This is required before fsync — fsync only operates on what the
	// kernel has received. Bytes still in our bufio.Writer are invisible
	// to fsync and would not be synced.
	if err := w.buf.Flush(); err != nil {
		return 0, fmt.Errorf("flush to kernel: %w", err)
	}

	// Sync the kernel's page cache to stable storage.
	// After this returns, the record is durable — it survives any
	// subsequent crash. This is the guarantee the WAL exists to provide.
	if err := w.file.Sync(); err != nil {
		return 0, fmt.Errorf("fsync: %w", err)
	}

	recordSize := int64(len(encoded))
	w.nextLSN += uint64(recordSize)
	w.size += recordSize

	// Rotate if the current segment has reached the size limit.
	if w.size >= maxSegmentSize {
		if err := w.rotate(); err != nil {
			return 0, fmt.Errorf("rotate: %w", err)
		}
	}

	return lsn, nil
}

// rotate closes the current segment and opens a new one.
// Must be called with w.mu held.
func (w *WAL) rotate() error {
	if err := w.file.Close(); err != nil {
		return err
	}
	w.size = 0
	return w.openSegment()
}

// Recover replays all segments in order, calling fn for each valid record.
// It stops at the first corrupt record (checksum mismatch or truncated header),
// which indicates the tail of the last segment was written partially before a crash.
// The corrupt record and everything after it is discarded — this is correct
// because the operation was never acknowledged to the caller.
//
// After Recover returns, the WAL is ready for new writes.
func (w *WAL) Recover(fn func(Record) error) error {
	w.mu.Lock()
	defer w.mu.Unlock()

	segments, err := filepath.Glob(filepath.Join(w.dir, "*.log"))
	if err != nil {
		return err
	}

	for _, seg := range segments {
		if err := w.recoverSegment(seg, fn); err != nil {
			return err
		}
	}

	return nil
}

func (w *WAL) recoverSegment(path string, fn func(Record) error) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	reader := bufio.NewReader(f)
	var lastGoodOffset int64

	for {
		// Track the byte offset before each read so we know where to truncate
		// if the next record is corrupt.
		offset, _ := f.Seek(0, io.SeekCurrent)

		rec, err := decode(reader)
		if err == io.EOF {
			break // clean end of segment
		}
		if err != nil {
			// Corrupt or truncated record at the tail.
			// Truncate the file at the last known-good offset and stop.
			log.Printf("WAL recovery: corrupt record at offset %d in %s, truncating",
				offset, filepath.Base(path))
			if terr := os.Truncate(path, lastGoodOffset); terr != nil {
				return fmt.Errorf("truncate corrupt tail: %w", terr)
			}
			break
		}

		if err := fn(rec); err != nil {
			return fmt.Errorf("recovery handler at LSN %d: %w", rec.LSN, err)
		}

		lastGoodOffset = offset + int64(headerSize+len(rec.Payload))
	}

	return nil
}

// Close flushes and closes the active segment.
func (w *WAL) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()

	if err := w.buf.Flush(); err != nil {
		return err
	}
	return w.file.Close()
}
```

---

## Crash Recovery: What Actually Happens

Recovery is the scenario that justifies everything else. Walk through it concretely.

The process is mid-write when power is cut. The last record written to the log file had its header written to the page cache but the payload write was interrupted. The page cache was partially flushed before the crash — so the header bytes made it to disk, but only 3 of the 20 payload bytes did.

On restart:

```
recoverSegment reads segment file
  → decode() reads 17-byte header successfully
  → decode() calls io.ReadFull(r, payload) expecting 20 bytes
  → gets 3 bytes then EOF
  → returns "truncated payload at LSN X"
recoverSegment truncates the file at lastGoodOffset
  → the corrupt 20-byte partial record is removed
  → the file now ends at the last fully written record
```

The operation that was in-progress is gone. That is correct — we never called `fsync` on it, which means we never acknowledged it to the caller, which means the caller knows it did not commit. The log is now consistent and ready for new writes.

This is the fundamental invariant: **a record exists in the WAL if and only if it was fully written and fsynced before the crash**. CRC32 enforces the "fully written" half. fsync enforces the "persisted before crash" half.

---

## The Key-Value Store

The WAL does nothing useful alone. Here is a simple in-memory K/V store that uses it to provide crash-safe persistence.

```go
// main.go

package main

import (
	"encoding/json"
	"fmt"
	"log"

	"github.com/amrrdev/wal/wal"
)

// KVPayload is what we encode into the WAL record payload.
// JSON is fine here — the payload format is independent of the WAL format.
type KVPayload struct {
	Key   string `json:"k"`
	Value string `json:"v,omitempty"`
}

// KVStore is an in-memory key-value store backed by a WAL.
// On startup it replays the WAL to reconstruct its state.
// Every write is immediately durable.
type KVStore struct {
	data map[string]string
	wal  *wal.WAL
}

func OpenKVStore(dir string) (*KVStore, error) {
	w, err := wal.Open(dir)
	if err != nil {
		return nil, fmt.Errorf("open wal: %w", err)
	}

	kv := &KVStore{
		data: make(map[string]string),
		wal:  w,
	}

	// Replay the WAL to reconstruct in-memory state.
	// Every record we wrote before the last crash is replayed here,
	// in the exact order it was written, rebuilding the map.
	if err := w.Recover(kv.apply); err != nil {
		return nil, fmt.Errorf("recover: %w", err)
	}

	return kv, nil
}

// apply is the recovery handler. It receives each valid WAL record
// and applies it to the in-memory map. This is called during Recover()
// and not during normal operation.
func (kv *KVStore) apply(rec wal.Record) error {
	var p KVPayload
	if err := json.Unmarshal(rec.Payload, &p); err != nil {
		return fmt.Errorf("unmarshal payload: %w", err)
	}

	switch rec.Type {
	case wal.TypeWrite:
		kv.data[p.Key] = p.Value
	case wal.TypeDelete:
		delete(kv.data, p.Key)
	}
	// TypeCommit records exist in the log but carry no state for this
	// simple store — they are relevant for multi-key transactions.
	return nil
}

// Set writes a key-value pair. The write is durable before returning.
func (kv *KVStore) Set(key, value string) error {
	payload, err := json.Marshal(KVPayload{Key: key, Value: value})
	if err != nil {
		return err
	}

	if _, err := kv.wal.Write(wal.TypeWrite, payload); err != nil {
		return fmt.Errorf("wal write: %w", err)
	}

	// Only update the in-memory map after the WAL write succeeds.
	// If the WAL write fails (disk full, fsync error), we do not update
	// the map — the store stays consistent with what is on disk.
	kv.data[key] = value
	return nil
}

// Delete removes a key. The deletion is durable before returning.
func (kv *KVStore) Delete(key string) error {
	payload, err := json.Marshal(KVPayload{Key: key})
	if err != nil {
		return err
	}

	if _, err := kv.wal.Write(wal.TypeDelete, payload); err != nil {
		return fmt.Errorf("wal write: %w", err)
	}

	delete(kv.data, key)
	return nil
}

// Get reads a key from the in-memory map. Reads never touch the WAL.
func (kv *KVStore) Get(key string) (string, bool) {
	v, ok := kv.data[key]
	return v, ok
}

func (kv *KVStore) Close() error {
	return kv.wal.Close()
}

func main() {
	kv, err := OpenKVStore("/tmp/wal-demo")
	if err != nil {
		log.Fatal(err)
	}
	defer kv.Close()

	kv.Set("user:1", "amr")
	kv.Set("user:2", "alice")
	kv.Delete("user:2")

	v, ok := kv.Get("user:1")
	fmt.Printf("user:1 = %q, found = %v\n", v, ok)

	_, ok = kv.Get("user:2")
	fmt.Printf("user:2 found = %v\n", ok)
}
```

---

## Design Decisions and Their Tradeoffs

**fsync on every write vs. group commit.**
We call `file.Sync()` after every record. This gives you the strongest durability guarantee — every write is immediately durable — at the cost of throughput. At 5ms per fsync, you cap out at 200 durable writes per second on a single WAL writer. PostgreSQL's `synchronous_commit = on` does the same thing by default and hits this same ceiling on spinning disks.

Group commit batches multiple writes and issues a single fsync, amortizing the disk latency across N writers. PostgreSQL implements this: multiple backends write their WAL records, one of them calls fsync on behalf of all of them, and all of them acknowledge their commits. Implementing group commit correctly requires a condition variable, a leader-election step among waiters, and careful handling of the case where the fsync fails mid-group. It is the natural next step after this implementation.

**LSN = byte offset.**
Setting LSN equal to the byte offset of the record in the log file means seeking to a specific LSN is a direct `Seek(lsn, io.SeekStart)` call. The alternative is a monotonic counter with a separate index mapping LSN → file offset. The direct encoding is simpler and is what PostgreSQL uses.

**bufio.Writer in front of the file.**
`bufio.Writer` batches small `Write()` calls into fewer `write()` syscalls. Without it, every `encode()` output triggers a syscall even though the encoded record is only a few dozen bytes. The buffer is always flushed explicitly before `fsync` — this is critical. `file.Sync()` operates on what the kernel has received; bytes sitting in our `bufio.Writer` are still in userspace and are invisible to the kernel, so they would not be synced.

**Truncating the corrupt tail on recovery.**
When we find a corrupt record during recovery, we truncate the file at the last good offset. This is the standard approach — PostgreSQL does exactly this. The alternative is to keep the corrupt bytes and require manual intervention, which is appropriate for some systems but not for an automatically self-recovering log.

**Segment files instead of a single file.**
A single log file grows forever. Segment files cap individual file sizes, which matters for three reasons: old segments can be deleted once their records have been checkpointed into the data files (freeing disk space), individual fsync calls are cheaper on smaller files, and recovery can be parallelized across segments. 64MB matches PostgreSQL's default `wal_segment_size`.

---

## What a Production WAL Adds

This implementation covers the core. A production system adds:

**Checkpointing** — periodically writing all in-memory state to data files and recording the checkpoint LSN. On recovery, replay starts from the checkpoint LSN, not the beginning of the log. Without checkpointing, recovery time grows proportionally to total WAL history. PostgreSQL checkpoints every 5 minutes or 1GB of WAL by default.

**WAL archiving** — shipping completed segments to S3 or another storage system before deleting them locally. This is Point-in-Time Recovery (PITR): restore to any moment by replaying WAL up to an arbitrary LSN. This is how Postgres cloud providers (Supabase, Neon, RDS) implement PITR.

**Replication** — streaming WAL records to replicas in real time. The replica applies the same records the primary wrote, maintaining an identical copy. This is PostgreSQL streaming replication at the implementation level — the replica's recovery loop runs continuously rather than only at startup.

**Group commit** — batching multiple writes behind a single fsync as described above. Required for write-heavy workloads where per-write fsync latency is the bottleneck.

---

## Conclusion

A WAL is the boundary between "data is in RAM" and "data is on disk." The implementation contract is simple: write the record, fsync, then acknowledge. Everything else — crash recovery, replication, PITR — follows from that contract being maintained consistently.

The full code is on [GitHub](https://github.com/amrrdev/wal).
