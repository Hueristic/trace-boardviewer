'use strict';

// Online-only (cloud placeholder) files on Windows. A reparse point that is a file of at least one cluster and holds no allocated
// blocks has its content elsewhere (the cloud provider): its name and size are known from the metadata, its content is not read.
// Node cannot read the reparse tag, so this is the metadata test, not the tag. NTFS keeps a smaller file inside its directory
// record, where a zero allocation says nothing; hence the size floor. Only call this for a reparse point (see directory-adapter.cjs
// and documents.cjs): a regular file with content has allocated blocks.

const ONLINE_MIN_BYTES = 4096;

function isOnlineOnly(stat) {
  return stat.isFile() && stat.size >= ONLINE_MIN_BYTES && stat.blocks === 0;
}

module.exports = Object.freeze({ ONLINE_MIN_BYTES, isOnlineOnly });
