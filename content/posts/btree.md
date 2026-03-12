---
title: "Implementing a B-Tree in TypeScript: What Actually Happens When Databases Index Your Data"
date: "2026-3-10"
readTime: "10 min read"
category: "Database Internals"
---

## Why B-Trees Exist

Your database has 50 million rows. You query by user ID. Without an index, the database reads every row, one by one, until it finds yours. That's a full table scan. It's slow. It gets slower as you add more data.

So you build an index. An index is a separate data structure that maps keys to row locations. Instead of scanning 50 million rows, you look up the key in the index, get a pointer, jump straight to the row.

The question is: what data structure do you use for the index?

Not a hash map. Hash maps are fast for exact lookups but useless for range queries. `WHERE age BETWEEN 20 AND 30` needs a structure that keeps data sorted.

Not a binary search tree. BSTs work in theory but fall apart at scale. A BST with a million nodes can be 20 levels deep. Each level is a disk read. 20 disk reads per query. Disks are slow.

B-Trees solve this. They keep data sorted for range queries. And they stay shallow — a B-Tree with a million nodes is only 3-4 levels deep. That's 3-4 disk reads per query. Every major database — PostgreSQL, MySQL, SQLite, MongoDB — uses B-Trees or a variant for indexes.

Let's build one.

---

## What a B-Tree Actually Is

A B-Tree is a self-balancing tree where each node holds multiple entries. Each entry is a **(key, value)** pair — the key is what you search by, the value is what you get back. In a database index, the key is the indexed column and the value is a pointer to the actual row on disk. In a general-purpose map, the value is whatever you want.

You configure a parameter called the **order** (or minimum degree), which we'll call `t`. It controls how many entries each node can hold.

Every non-root node must have at least `t - 1` entries and at most `2t - 1` entries. The root can have as few as 1.

Each internal node with `n` entries has exactly `n + 1` children. Leaf nodes have no children.

All leaves are at the same depth. That's the key property. No matter what you insert or delete, the tree stays perfectly balanced. Every search takes the exact same number of steps.

Let's define the node. We use a `comparator` function to keep keys generic — any type that can be ordered works:

```typescript
type Comparator<K> = (a: K, b: K) => number;

interface Entry<K, V> {
  key: K;
  value: V;
}

class BTreeNode<K, V> {
  entries: Entry<K, V>[];
  children: BTreeNode<K, V>[];
  isLeaf: boolean;

  constructor(isLeaf: boolean) {
    this.entries = [];
    this.children = [];
    this.isLeaf = isLeaf;
  }
}
```

Each node holds an array of `entries` (key-value pairs), an array of `children`, and a flag for whether it's a leaf. The children array is always one longer than the entries array for internal nodes — `children[i]` holds everything less than `entries[i].key`, and `children[entries.length]` holds everything greater than the last key.

---

## The Tree Shell

```typescript
class BTree<K, V> {
  root: BTreeNode<K, V>;
  t: number;
  comparator: Comparator<K>;

  constructor(t: number, comparator: Comparator<K>) {
    this.t = t;
    this.comparator = comparator;
    this.root = new BTreeNode<K, V>(true);
  }
}
```

We pass in a `comparator` so the tree works with any key type — numbers, strings, dates, whatever. With `t = 3`, nodes hold 2 to 5 entries. With `t = 2`, you get a 2-3-4 tree — the minimum useful B-Tree.

For the examples below we'll use `(a, b) => a - b` for numeric keys.

---

## Search

Search is the simplest operation. Start at the root. At each node, find where the key would be. If it's there, return the value. If not, go into the right child.

```typescript
search(node: BTreeNode<K, V>, key: K): V | null {
  let i = 0;

  // Find the first entry whose key is >= what we're looking for
  while (i < node.entries.length && this.comparator(key, node.entries[i].key) > 0) {
    i++;
  }

  // Found it — return the value
  if (i < node.entries.length && this.comparator(key, node.entries[i].key) === 0) {
    return node.entries[i].value;
  }

  // We're at a leaf and didn't find it — it's not in the tree
  if (node.isLeaf) {
    return null;
  }

  // Go into the appropriate child
  return this.search(node.children[i], key);
}
```

At each node, we scan entries until we find one whose key is `>=` our target. If it equals our target, we return its value. If we reach a leaf without finding it, it doesn't exist. Otherwise, we descend into `children[i]` — the subtree containing keys between `entries[i-1].key` and `entries[i].key`.

The depth of the tree is `O(log n)`. So search is `O(log n)`. For a million entries with `t = 100`, the tree is maybe 3 levels deep. Three node reads. That's why databases love this structure.

---

## Insertion: The Hard Part

Insertion is where B-Trees get interesting. You always insert into a leaf. But leaves can fill up. When a node has `2t - 1` entries (it's full), you can't add more. You need to split it.

**Splitting a node**: Take the middle entry. Push it up to the parent. The left half of the node stays as one child. The right half becomes a new sibling.

This is why B-Trees stay balanced. Splits propagate up. If the root splits, a new root is created, and the tree grows taller by exactly one level — uniformly.

We'll use the **proactive split** approach: as we walk down to find the insertion point, we split any full nodes we encounter. This means we never need to walk back up.

### Splitting a Child

```typescript
private splitChild(parent: BTreeNode<K, V>, i: number): void {
  const t = this.t;
  const fullChild = parent.children[i];
  const newNode = new BTreeNode<K, V>(fullChild.isLeaf);

  // The middle entry gets promoted to the parent
  const midEntry = fullChild.entries[t - 1];

  // New node gets the right half of the full child's entries
  newNode.entries = fullChild.entries.splice(t, t - 1);

  // If the full child isn't a leaf, the new node gets the right half of its children too
  if (!fullChild.isLeaf) {
    newNode.children = fullChild.children.splice(t, t);
  }

  // Remove the middle entry from the full child (it's going up to the parent)
  fullChild.entries.splice(t - 1, 1);

  // Insert the middle entry into the parent at position i
  parent.entries.splice(i, 0, midEntry);

  // Insert the new node as a child of parent at position i + 1
  parent.children.splice(i + 1, 0, newNode);
}
```

Before the split, `fullChild` has `2t - 1` entries. After:

- `fullChild` keeps the left `t - 1` entries
- `midEntry` (with its key and value) goes up to the parent
- `newNode` gets the right `t - 1` entries

Both children now have `t - 1` entries — the minimum allowed. The parent gained one entry and one child pointer.

### Inserting Into a Non-Full Node

```typescript
private insertNonFull(node: BTreeNode<K, V>, key: K, value: V): void {
  let i = node.entries.length - 1;

  if (node.isLeaf) {
    // Make space and insert the new entry in sorted order
    node.entries.push({ key, value }); // placeholder at end
    while (i >= 0 && this.comparator(key, node.entries[i].key) < 0) {
      node.entries[i + 1] = node.entries[i];
      i--;
    }
    node.entries[i + 1] = { key, value };
  } else {
    // Find the right child to recurse into
    while (i >= 0 && this.comparator(key, node.entries[i].key) < 0) {
      i--;
    }

    // If the key already exists in this internal node, update its value in place
    if (i >= 0 && this.comparator(key, node.entries[i].key) === 0) {
      node.entries[i].value = value;
      return;
    }

    i++;

    // If that child is full, split it first
    if (node.children[i].entries.length === 2 * this.t - 1) {
      this.splitChild(node, i);

      // After the split, the middle entry moved up. Which child do we go into?
      if (this.comparator(key, node.entries[i].key) > 0) {
        i++;
      } else if (this.comparator(key, node.entries[i].key) === 0) {
        // The promoted key is exactly what we're inserting — update it
        node.entries[i].value = value;
        return;
      }
    }

    this.insertNonFull(node.children[i], key, value);
  }
}
```

One thing to notice: we handle duplicate keys by updating the value in place. That's map semantics — `insert(key, value)` is also an upsert.

### The Public Insert Method

```typescript
insert(key: K, value: V): void {
  const root = this.root;

  // If root is full, the tree grows in height
  if (root.entries.length === 2 * this.t - 1) {
    const newRoot = new BTreeNode<K, V>(false);
    newRoot.children.push(this.root);
    this.root = newRoot;
    this.splitChild(newRoot, 0);
    this.insertNonFull(newRoot, key, value);
  } else {
    this.insertNonFull(root, key, value);
  }
}
```

One special case: if the root itself is full, we create a new empty root, make the old root its first child, then split the old root. Now the new root has one entry (the promoted middle entry) and two children. The tree just grew by one level.

This is the only way a B-Tree grows taller. Not by adding depth to one branch — by the root splitting, uniformly.

---

## Deletion: The Annoying Part

Deletion is more complex than insertion. When you delete an entry, you might leave a node with too few entries (`< t - 1`). You need to fix that by either borrowing an entry from a sibling or merging with a sibling.

There are three cases:

**Case 1**: The key is in a leaf node. Delete it directly.

**Case 2**: The key is in an internal node. You can't just remove it — internal entries separate children. Replace it with either its in-order predecessor (largest entry in the left subtree) or in-order successor (smallest entry in the right subtree). Then delete that replacement from the subtree.

**Case 3**: The key isn't in the current node. Find the right child to recurse into. Before recursing, make sure that child has at least `t` entries. If it doesn't, fix it first (borrow from a sibling or merge).

### Finding Predecessor and Successor

```typescript
private getPredecessor(node: BTreeNode<K, V>, i: number): Entry<K, V> {
  // Go to left child of entries[i], then go right as far as possible
  let curr = node.children[i];
  while (!curr.isLeaf) {
    curr = curr.children[curr.children.length - 1];
  }
  return curr.entries[curr.entries.length - 1];
}

private getSuccessor(node: BTreeNode<K, V>, i: number): Entry<K, V> {
  // Go to right child of entries[i], then go left as far as possible
  let curr = node.children[i + 1];
  while (!curr.isLeaf) {
    curr = curr.children[0];
  }
  return curr.entries[0];
}
```

These return the full `Entry<K, V>` — both key and value — because when we replace an internal entry, we need to carry the value along too.

### Borrowing from Siblings

When a child has too few entries, we try to borrow from an adjacent sibling.

```typescript
private borrowFromPrev(node: BTreeNode<K, V>, i: number): void {
  const child = node.children[i];
  const sibling = node.children[i - 1];

  // The parent's entry drops down to the front of child
  child.entries.unshift(node.entries[i - 1]);

  // If the sibling has children, its last child moves to the front of child's children
  if (!sibling.isLeaf) {
    child.children.unshift(sibling.children.pop()!);
  }

  // The sibling's last entry rises up to replace the parent's entry
  node.entries[i - 1] = sibling.entries.pop()!;
}

private borrowFromNext(node: BTreeNode<K, V>, i: number): void {
  const child = node.children[i];
  const sibling = node.children[i + 1];

  // The parent's entry drops down to the end of child
  child.entries.push(node.entries[i]);

  // If the sibling has children, its first child moves to the end of child's children
  if (!sibling.isLeaf) {
    child.children.push(sibling.children.shift()!);
  }

  // The sibling's first entry rises up to replace the parent's entry
  node.entries[i] = sibling.entries.shift()!;
}
```

Borrowing is a rotation. The parent entry drops into the child, and the sibling's boundary entry rises up to replace it. Both key and value travel together.

### Merging Nodes

If neither sibling can lend an entry (both are at the minimum), we merge two children into one.

```typescript
private merge(node: BTreeNode<K, V>, i: number): void {
  const leftChild = node.children[i];
  const rightChild = node.children[i + 1];

  // Pull the separator entry down from the parent into the left child
  leftChild.entries.push(node.entries[i]);

  // Move all entries from right child into left child
  leftChild.entries.push(...rightChild.entries);

  // Move all children from right child into left child
  if (!leftChild.isLeaf) {
    leftChild.children.push(...rightChild.children);
  }

  // Remove the separator entry from parent
  node.entries.splice(i, 1);

  // Remove the right child pointer from parent
  node.children.splice(i + 1, 1);
}
```

After merging, the left child has `(t-1) + 1 + (t-1) = 2t-1` entries — exactly a full node. The parent lost one entry and one child pointer.

### The Delete Method

```typescript
delete(key: K): void {
  if (!this.root.entries.length) return;
  this._delete(this.root, key);

  // If root is now empty (after a merge), its only child becomes the new root
  if (this.root.entries.length === 0 && !this.root.isLeaf) {
    this.root = this.root.children[0];
  }
}

private _delete(node: BTreeNode<K, V>, key: K): void {
  const t = this.t;
  let i = node.entries.findIndex(e => this.comparator(key, e.key) <= 0);
  if (i === -1) i = node.entries.length;

  if (i < node.entries.length && this.comparator(key, node.entries[i].key) === 0) {
    // Key is in this node
    if (node.isLeaf) {
      // Case 1: leaf — just remove it
      node.entries.splice(i, 1);
    } else {
      // Case 2: internal node
      if (node.children[i].entries.length >= t) {
        // Left child has enough entries — replace with predecessor
        const pred = this.getPredecessor(node, i);
        node.entries[i] = pred;
        this._delete(node.children[i], pred.key);
      } else if (node.children[i + 1].entries.length >= t) {
        // Right child has enough entries — replace with successor
        const succ = this.getSuccessor(node, i);
        node.entries[i] = succ;
        this._delete(node.children[i + 1], succ.key);
      } else {
        // Both children have minimum entries — merge and delete from merged node
        this.merge(node, i);
        this._delete(node.children[i], key);
      }
    }
  } else {
    // Case 3: key is not in this node, go into the appropriate child
    if (node.isLeaf) return; // key doesn't exist

    const isLastChild = i === node.entries.length;

    // Make sure the child we're going into has at least t entries
    if (node.children[i].entries.length < t) {
      this.fill(node, i);
      if (isLastChild && i > node.entries.length) i--;
    }

    this._delete(node.children[i], key);
  }
}

private fill(node: BTreeNode<K, V>, i: number): void {
  if (i > 0 && node.children[i - 1].entries.length >= this.t) {
    this.borrowFromPrev(node, i);
  } else if (i < node.entries.length && node.children[i + 1].entries.length >= this.t) {
    this.borrowFromNext(node, i);
  } else {
    if (i < node.entries.length) this.merge(node, i);
    else this.merge(node, i - 1);
  }
}
```

---

## Putting It All Together

Here's the complete implementation:

```typescript
type Comparator<K> = (a: K, b: K) => number;

interface Entry<K, V> {
  key: K;
  value: V;
}

class BTreeNode<K, V> {
  entries: Entry<K, V>[];
  children: BTreeNode<K, V>[];
  isLeaf: boolean;

  constructor(isLeaf: boolean) {
    this.entries = [];
    this.children = [];
    this.isLeaf = isLeaf;
  }
}

class BTree<K, V> {
  root: BTreeNode<K, V>;
  t: number;
  comparator: Comparator<K>;

  constructor(t: number, comparator: Comparator<K>) {
    this.t = t;
    this.comparator = comparator;
    this.root = new BTreeNode<K, V>(true);
  }

  search(node: BTreeNode<K, V>, key: K): V | null {
    let i = 0;
    while (i < node.entries.length && this.comparator(key, node.entries[i].key) > 0) i++;
    if (i < node.entries.length && this.comparator(key, node.entries[i].key) === 0) {
      return node.entries[i].value;
    }
    if (node.isLeaf) return null;
    return this.search(node.children[i], key);
  }

  private splitChild(parent: BTreeNode<K, V>, i: number): void {
    const t = this.t;
    const fullChild = parent.children[i];
    const newNode = new BTreeNode<K, V>(fullChild.isLeaf);
    const midEntry = fullChild.entries[t - 1];
    newNode.entries = fullChild.entries.splice(t, t - 1);
    if (!fullChild.isLeaf) newNode.children = fullChild.children.splice(t, t);
    fullChild.entries.splice(t - 1, 1);
    parent.entries.splice(i, 0, midEntry);
    parent.children.splice(i + 1, 0, newNode);
  }

  private insertNonFull(node: BTreeNode<K, V>, key: K, value: V): void {
    let i = node.entries.length - 1;
    if (node.isLeaf) {
      node.entries.push({ key, value });
      while (i >= 0 && this.comparator(key, node.entries[i].key) < 0) {
        node.entries[i + 1] = node.entries[i];
        i--;
      }
      node.entries[i + 1] = { key, value };
    } else {
      while (i >= 0 && this.comparator(key, node.entries[i].key) < 0) i--;
      if (i >= 0 && this.comparator(key, node.entries[i].key) === 0) {
        node.entries[i].value = value;
        return;
      }
      i++;
      if (node.children[i].entries.length === 2 * this.t - 1) {
        this.splitChild(node, i);
        if (this.comparator(key, node.entries[i].key) > 0) i++;
        else if (this.comparator(key, node.entries[i].key) === 0) {
          node.entries[i].value = value;
          return;
        }
      }
      this.insertNonFull(node.children[i], key, value);
    }
  }

  insert(key: K, value: V): void {
    const root = this.root;
    if (root.entries.length === 2 * this.t - 1) {
      const newRoot = new BTreeNode<K, V>(false);
      newRoot.children.push(this.root);
      this.root = newRoot;
      this.splitChild(newRoot, 0);
      this.insertNonFull(newRoot, key, value);
    } else {
      this.insertNonFull(root, key, value);
    }
  }

  private getPredecessor(node: BTreeNode<K, V>, i: number): Entry<K, V> {
    let curr = node.children[i];
    while (!curr.isLeaf) curr = curr.children[curr.children.length - 1];
    return curr.entries[curr.entries.length - 1];
  }

  private getSuccessor(node: BTreeNode<K, V>, i: number): Entry<K, V> {
    let curr = node.children[i + 1];
    while (!curr.isLeaf) curr = curr.children[0];
    return curr.entries[0];
  }

  private borrowFromPrev(node: BTreeNode<K, V>, i: number): void {
    const child = node.children[i];
    const sibling = node.children[i - 1];
    child.entries.unshift(node.entries[i - 1]);
    if (!sibling.isLeaf) child.children.unshift(sibling.children.pop()!);
    node.entries[i - 1] = sibling.entries.pop()!;
  }

  private borrowFromNext(node: BTreeNode<K, V>, i: number): void {
    const child = node.children[i];
    const sibling = node.children[i + 1];
    child.entries.push(node.entries[i]);
    if (!sibling.isLeaf) child.children.push(sibling.children.shift()!);
    node.entries[i] = sibling.entries.shift()!;
  }

  private merge(node: BTreeNode<K, V>, i: number): void {
    const leftChild = node.children[i];
    const rightChild = node.children[i + 1];
    leftChild.entries.push(node.entries[i]);
    leftChild.entries.push(...rightChild.entries);
    if (!leftChild.isLeaf) leftChild.children.push(...rightChild.children);
    node.entries.splice(i, 1);
    node.children.splice(i + 1, 1);
  }

  private fill(node: BTreeNode<K, V>, i: number): void {
    if (i > 0 && node.children[i - 1].entries.length >= this.t) {
      this.borrowFromPrev(node, i);
    } else if (i < node.entries.length && node.children[i + 1].entries.length >= this.t) {
      this.borrowFromNext(node, i);
    } else {
      if (i < node.entries.length) this.merge(node, i);
      else this.merge(node, i - 1);
    }
  }

  private _delete(node: BTreeNode<K, V>, key: K): void {
    const t = this.t;
    let i = node.entries.findIndex((e) => this.comparator(key, e.key) <= 0);
    if (i === -1) i = node.entries.length;

    if (i < node.entries.length && this.comparator(key, node.entries[i].key) === 0) {
      if (node.isLeaf) {
        node.entries.splice(i, 1);
      } else {
        if (node.children[i].entries.length >= t) {
          const pred = this.getPredecessor(node, i);
          node.entries[i] = pred;
          this._delete(node.children[i], pred.key);
        } else if (node.children[i + 1].entries.length >= t) {
          const succ = this.getSuccessor(node, i);
          node.entries[i] = succ;
          this._delete(node.children[i + 1], succ.key);
        } else {
          this.merge(node, i);
          this._delete(node.children[i], key);
        }
      }
    } else {
      if (node.isLeaf) return;
      const isLastChild = i === node.entries.length;
      if (node.children[i].entries.length < t) {
        this.fill(node, i);
        if (isLastChild && i > node.entries.length) i--;
      }
      this._delete(node.children[i], key);
    }
  }

  delete(key: K): void {
    if (!this.root.entries.length) return;
    this._delete(this.root, key);
    if (this.root.entries.length === 0 && !this.root.isLeaf) {
      this.root = this.root.children[0];
    }
  }

  traverse(node: BTreeNode<K, V> = this.root, depth = 0): void {
    const label = node.entries.map((e) => `${e.key}:${e.value}`).join(", ");
    console.log(" ".repeat(depth * 2) + "[" + label + "]");
    for (const child of node.children) {
      this.traverse(child, depth + 1);
    }
  }
}
```

Run it with a numeric key and a string value — like a simple user ID to username map:

```typescript
const tree = new BTree<number, string>(3, (a, b) => a - b);

tree.insert(10, "alice");
tree.insert(20, "bob");
tree.insert(5, "carol");
tree.insert(6, "dave");
tree.insert(12, "eve");
tree.insert(30, "frank");
tree.insert(7, "grace");
tree.insert(17, "heidi");

tree.traverse();
// [10:alice, 20:bob]
//   [5:carol, 6:dave, 7:grace]
//   [12:eve, 17:heidi]
//   [30:frank]

console.log(tree.search(tree.root, 17)); // "heidi"
console.log(tree.search(tree.root, 99)); // null

// Upsert — update an existing key's value
tree.insert(17, "hannah");
console.log(tree.search(tree.root, 17)); // "hannah"

tree.delete(6);
tree.delete(20);
tree.traverse();
```

Or with string keys:

```typescript
const index = new BTree<string, number>(3, (a, b) => a.localeCompare(b));

index.insert("apple", 1);
index.insert("banana", 2);
index.insert("cherry", 3);

console.log(index.search(index.root, "banana")); // 2
```

The comparator is the only thing that changes. The rest of the tree doesn't care what type the keys are.

---

## What You Actually Have

A generic `BTree<K, V>` that works with any key type, maps keys to values, and handles upserts. Every node holds between `t-1` and `2t-1` entries. Every leaf sits at the same depth. Every search, insert, and delete runs in `O(log n)`.

The invariants that make this work:

- Every non-root node has between `t-1` and `2t-1` entries. No node is too empty or too full.
- Every internal node with `n` entries has exactly `n+1` children. The tree is always navigable.
- All leaves are at the same depth. Search time is perfectly predictable.

Insertions split nodes on the way down. Deletions borrow or merge on the way down. Neither operation ever needs a second pass back up the tree.

That's it. It's not magic. It's just a tree that keeps itself balanced by carefully controlling how nodes grow and shrink — and now it actually stores your data.
