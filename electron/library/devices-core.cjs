/* Generated from src/lib/library/devices/main-entry.ts by scripts/library-devices-core.cjs. Do not edit. */
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
//#region src/lib/library/devices/paths.ts
/** Text longer than this is not normalised for search; the caller gets a truncated key instead of an unbounded scan. */
var MAX_SEARCH_TEXT = 1024;
/** The canonical stored form of a relative path: segments joined with "/". */
function canonicalPath(segments) {
	return segments.join("/");
}
/**
* Comparison key of a relative path. Only win32 folds case: NTFS never keeps two names that differ only by case in one folder.
* darwin and linux compare exactly. A darwin volume may be case-sensitive (APFS can be), and the code cannot know the volume's
* policy, so folding there would merge two different files. On a case-insensitive darwin volume the stored spelling of each entry
* is stable, so exact keys still identify each file. The key is never shown as a name and never used to open a file.
*
* Decision (D8): darwin keys stay exact. A correction that names a spelling of an existing file which differs only
* by letter case or Unicode normalisation is not redirected and not reported as missing either: it is a case-collision that needs
* a manual confirmation (see `spellingKey` and catalogue.ts). win32 and linux are unchanged.
*/
function identityKey(segments, platform) {
	const joined = canonicalPath(segments);
	return platform === "win32" ? joined.toLowerCase() : joined;
}
/**
* A coarse spelling key of a canonical path: Unicode NFC, then lower case. Used only to find candidate files for a correction whose
* exact target is missing on darwin. It never decides identity (that is `identityKey`), so two files that share it stay separate.
*/
function spellingKey(canonical) {
	return canonical.normalize("NFC").toLowerCase();
}
/**
* Keys that two or more distinct paths share. Such entries are collisions: the caller keeps each of them as its own state and
* never merges, matches or overwrites one of them through the shared key. A path listed twice is not a collision. Linear.
*/
function collidingKeys(entries) {
	const first = /* @__PURE__ */ new Map();
	const colliding = /* @__PURE__ */ new Set();
	for (const entry of entries) {
		const seen = first.get(entry.key);
		if (seen === void 0) first.set(entry.key, entry.path);
		else if (seen !== entry.path) colliding.add(entry.key);
	}
	return colliding;
}
/**
* Search key of free text (folder, file or alias names): NFKD, combining marks removed (accents), the Polish stroke letters ł and Ł
* folded to l and L (NFKD does not decompose them), lower case, and separators (space, "_", "-", ".", slashes) unified to one
* space. Linear in the length of the text, which is cut at MAX_SEARCH_TEXT.
*/
function searchKey(text) {
	if (typeof text !== "string") return "";
	return (text.length > MAX_SEARCH_TEXT ? text.slice(0, MAX_SEARCH_TEXT) : text).normalize("NFKD").replace(/\p{M}+/gu, "").replace(/[łŁ]/g, "l").toLowerCase().replace(/[\s_\-./\\]+/g, " ").trim();
}
/** Lower-cased extension without the dot; "" when the name has none (a leading dot is not an extension). */
function extensionOf$1(name) {
	const dot = name.lastIndexOf(".");
	if (dot <= 0 || dot === name.length - 1) return "";
	return name.slice(dot + 1).toLowerCase();
}
//#endregion
//#region src/lib/library/devices/folder-map.ts
/**
* Recursive folder map of one selected root, with the relative hierarchy kept as the index structure.
*
* The walker is read-only: it asks a DirectoryPort for the entries of one folder and never opens, renames, moves or deletes
* anything. Links, junctions and other Windows reparse points (cloud placeholders, dedup, app execution links) are not followed or
* listed; each is recorded as skipped and the map is marked incomplete. A folder that cannot be read is recorded and the walk continues. Limits (depth
* and entry count) make the map partial, and a partial map is reported as incomplete so that the caller can keep availability
* states unknown instead of claiming absence.
*
* OS sidecar files (AppleDouble "._*", ".DS_Store", "Thumbs.db", "desktop.ini") are written by the operating system, not by the
* user, and never describe a board. The walker skips them here, the only place that filters them: they are recorded with the
* reason "sidecar" and counted in skippedCount, so they never reach the identity, the matching or the corrections.
*
* Iterative (explicit stack), deterministic (entries sorted by code unit) and linear in the number of entries.
*/
var DEFAULT_LIMITS = {
	maxDepth: 48,
	maxEntries: 25e4
};
/** Error code of a walk stopped by its signal. The walk never returns a partial map after a cancel. */
var CANCELLED_CODE = "CANCELLED";
function cancelledError() {
	return Object.assign(/* @__PURE__ */ new Error("the walk was cancelled"), {
		name: "AbortError",
		code: CANCELLED_CODE
	});
}
/**
* True for an operating-system sidecar file name (compared case-insensitively): an AppleDouble "._" file, ".DS_Store",
* "Thumbs.db" or "desktop.ini". A user file with the same name would be skipped too; these names are never board files.
*/
function isSidecarName(name) {
	const lower = name.toLowerCase();
	return lower.startsWith("._") || lower === ".ds_store" || lower === "thumbs.db" || lower === "desktop.ini";
}
var DIAGNOSTIC_CODES = /* @__PURE__ */ new Set([
	"EACCES",
	"EPERM",
	"ENOENT",
	"ENOTDIR",
	"EISDIR",
	"ELOOP",
	"ENAMETOOLONG",
	"EBUSY",
	"EIO",
	"EMFILE",
	"ENFILE",
	"EAGAIN",
	"EINVAL",
	"ADAPTER_ROOT",
	"ADAPTER_ROOT_NOT_DIRECTORY",
	"ADAPTER_INVALID_SEGMENT",
	"ADAPTER_LINK",
	"ADAPTER_NOT_DIRECTORY",
	"ADAPTER_ESCAPES_ROOT",
	"UNKNOWN"
]);
function diagnosticCodeOf(source) {
	const code = typeof source === "object" && source !== null && "code" in source ? source.code : void 0;
	return typeof code === "string" && DIAGNOSTIC_CODES.has(code) ? code : void 0;
}
function makeFolder(name, segments, platform) {
	return {
		name,
		path: canonicalPath(segments),
		key: identityKey(segments, platform),
		folders: [],
		files: [],
		readState: "pending",
		fileCount: 0,
		folderCount: 0,
		bytes: 0
	};
}
/** Maps the tree under the root that `port` reads. Never throws for a bad entry; unreadable folders become skip records. */
async function mapFolderTree(port, platform, limits = DEFAULT_LIMITS, options = {}) {
	const skipPaths = options.skipPaths ?? /* @__PURE__ */ new Set();
	const root = makeFolder("", [], platform);
	const parentOf = /* @__PURE__ */ new Map();
	const order = [];
	const skipped = [];
	let skippedCount = 0;
	let complete = true;
	let limitReached = false;
	let entries = 0;
	const skip = (path, reason, code) => {
		skippedCount++;
		if (skipped.length < 500) skipped.push(code === void 0 ? {
			path,
			reason
		} : {
			path,
			reason,
			code
		});
		if (reason === "unreadable" || reason === "unknown" || reason === "reparse" || reason === "too-deep" || reason === "limit" || reason === "user-skipped") complete = false;
		if (reason === "limit") limitReached = true;
	};
	const stack = [{
		node: root,
		segments: [],
		depth: 0
	}];
	order.push(root);
	while (stack.length > 0) {
		if (options.signal?.aborted) throw cancelledError();
		const frame = stack.pop();
		if (entries >= limits.maxEntries) {
			frame.node.readState = "skipped";
			skip(canonicalPath(frame.segments), "limit");
			continue;
		}
		if (frame.depth >= limits.maxDepth) {
			frame.node.readState = "skipped";
			skip(canonicalPath(frame.segments), "too-deep");
			continue;
		}
		let listing;
		try {
			listing = await port.readDir(frame.segments);
		} catch (error) {
			frame.node.readState = "unreadable";
			const code = diagnosticCodeOf(error);
			if (code !== void 0) frame.node.code = code;
			skip(canonicalPath(frame.segments), "unreadable", code);
			continue;
		}
		frame.node.readState = "listed";
		const sorted = [...listing].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
		for (const entry of sorted) {
			if (entries >= limits.maxEntries) {
				skip(canonicalPath([...frame.segments, entry.name]), "limit");
				continue;
			}
			entries++;
			const childPath = [...frame.segments, entry.name];
			if (entry.name === "" || entry.name === "." || entry.name === ".." || entry.name.includes("/") || platform === "win32" && entry.name.includes("\\")) {
				skip(entry.name, "other-kind");
				continue;
			}
			if (entry.kind === "link") {
				skip(canonicalPath(childPath), "link", entry.code);
				continue;
			}
			if (entry.kind === "reparse") {
				skip(canonicalPath(childPath), "reparse");
				continue;
			}
			if (entry.kind === "other") {
				skip(canonicalPath(childPath), "other-kind");
				continue;
			}
			if (entry.kind === "unknown") {
				skip(canonicalPath(childPath), "unknown", diagnosticCodeOf(entry));
				continue;
			}
			if (entry.kind === "file") {
				if (isSidecarName(entry.name)) {
					skip(canonicalPath(childPath), "sidecar");
					continue;
				}
				const size = typeof entry.size === "number" && Number.isFinite(entry.size) && entry.size >= 0 ? entry.size : 0;
				frame.node.files.push({
					name: entry.name,
					path: canonicalPath(childPath),
					key: identityKey(childPath, platform),
					size,
					extension: extensionOf$1(entry.name),
					...entry.online === true ? { online: true } : {}
				});
				continue;
			}
			if (skipPaths.has(canonicalPath(childPath))) {
				skip(canonicalPath(childPath), "user-skipped");
				continue;
			}
			const child = makeFolder(entry.name, childPath, platform);
			frame.node.folders.push(child);
			parentOf.set(child, frame.node);
			order.push(child);
			stack.push({
				node: child,
				segments: childPath,
				depth: frame.depth + 1
			});
		}
	}
	for (let index = order.length - 1; index >= 0; index--) {
		const node = order[index];
		let fileCount = node.files.length;
		let folderCount = node.folders.length;
		let bytes = node.files.reduce((sum, file) => sum + file.size, 0);
		for (const child of node.folders) {
			fileCount += child.fileCount;
			folderCount += child.folderCount;
			bytes += child.bytes;
		}
		node.fileCount = fileCount;
		node.folderCount = folderCount;
		node.bytes = bytes;
	}
	return {
		root,
		skipped,
		skippedCount,
		complete,
		fileCount: root.fileCount,
		folderCount: root.folderCount,
		limitReached
	};
}
//#endregion
//#region src/lib/library/knowledge/chars.ts
/**
* Character helpers shared by the Library's recognition modules.
*
* Every recogniser here scans text once, by hand, with no regular expression that can backtrack, so its cost is linear in
* the length of the text. Texts come from file names, folder names, PDF title blocks and board-file headers; none of them
* is trusted. Two rules keep the cost and the output bounded:
*
*  - only the first `MAX_TEXT_LENGTH` UTF-16 units of a text are looked at;
*  - a call returns at most `MAX_MATCHES` results.
*
* "Folding" maps one UTF-16 unit to one unit, so a position in the folded text is a position in the original text: ASCII
* letters become upper case, full-width ASCII becomes ASCII, the dashes of Unicode become "-", the blanks of Unicode and the
* control characters become " ". Nothing else changes (no normalisation that could shorten or lengthen the text).
*
* The optional `WorkMeter` counts the characters a call examines. Tests use it to show that the work grows linearly with
* the input without measuring time.
*/
/** The longest text (in UTF-16 units) any recogniser looks at; the rest is ignored. */
var MAX_TEXT_LENGTH = 1e5;
/** Adds `count` to an optional meter. */
function tick(meter, count = 1) {
	if (meter !== void 0) meter.steps += count;
}
var isDigitCode = (code) => code >= 48 && code <= 57;
/** Upper-case ASCII letter; call it on folded codes. */
var isLetterCode = (code) => code >= 65 && code <= 90;
var isAlnumCode = (code) => code >= 48 && code <= 57 || code >= 65 && code <= 90;
/** Folds one UTF-16 unit for matching (see the header). */
function foldCode(code) {
	if (code < 128) {
		if (code >= 97 && code <= 122) return code - 32;
		return code < 33 ? 32 : code;
	}
	if (code >= 65281 && code <= 65374) {
		const ascii = code - 65248;
		return ascii >= 97 && ascii <= 122 ? ascii - 32 : ascii;
	}
	if (code >= 8208 && code <= 8213 || code === 8722 || code === 65112 || code === 65123 || code === 8259) return 45;
	if (code === 160 || code === 5760 || code >= 8192 && code <= 8205 || code === 8232 || code === 8233 || code === 8239 || code === 8287 || code === 12288 || code === 65279) return 32;
	return code;
}
/** The folded code at `index`, or -1 outside the text. */
function foldedAt(text, index, length = text.length) {
	return index >= 0 && index < length ? foldCode(text.charCodeAt(index)) : -1;
}
/** The number of units of `text` a recogniser looks at. Non-strings have none. */
function scanLength(text) {
	return typeof text === "string" ? Math.min(text.length, MAX_TEXT_LENGTH) : 0;
}
var RECOGNITION_SCOPES = [
	"name",
	"folder",
	"archive",
	"header",
	"pdf-metadata",
	"outline",
	"title-block",
	"schematic",
	"ocr",
	"body"
];
/** Letters of any script or digits, for words in the lexicons (the folded ASCII range plus the letters above it). */
function isWordCode(code) {
	if (code < 128) return code >= 48 && code <= 57 || code >= 65 && code <= 90 || code >= 97 && code <= 122;
	if (code < 192) return false;
	if (code === 215) return false;
	if (code === 247) return false;
	if (code >= 8192 && code <= 11263) return false;
	if (code >= 12288 && code <= 12351) return false;
	if (code >= 65280 && code <= 65381) return false;
	return !(code >= 55296 && code <= 57343);
}
var COMBINING_MARKS = /[̀-ͯ]/g;
/** Lower-cases a short word and removes the accents (hu "alaplap" and "tápegység" share a key with their plain spellings). */
function lexiconKey(word) {
	let ascii = true;
	for (let index = 0; index < word.length; index++) if (word.charCodeAt(index) > 127) {
		ascii = false;
		break;
	}
	const lower = word.toLowerCase();
	return ascii ? lower : lower.normalize("NFD").replace(COMBINING_MARKS, "");
}
//#endregion
//#region src/lib/library/knowledge/board-number-shapes.ts
var lit = (v) => ({
	t: "lit",
	v
});
var alt = (...v) => ({
	t: "alt",
	v
});
var D = (min, max = min) => ({
	t: "D",
	min,
	max
});
var A = (min, max = min) => ({
	t: "A",
	min,
	max
});
var X = (min, max = min, need = {}) => ({
	t: "X",
	min,
	max,
	...need
});
var S = (loose = 0) => ({
	t: "S",
	loose
});
var dot = () => ({ t: "dot" });
var opt = (...segs) => ({
	t: "opt",
	segs,
	revision: false
});
var rev = (...segs) => ({
	t: "opt",
	segs,
	revision: true
});
function shape(id, description, vendor, confidence, scopes, segments, example, normalizedExample, extra = {}) {
	return {
		id,
		description,
		vendor,
		confidence,
		scopes,
		segments,
		example,
		normalizedExample,
		...extra
	};
}
var BOARD_NUMBER_SHAPES = [
	shape("logic-board-820", "Apple logic board number (820-, four or five digits, optional revision letter)", "apple", 85, "all", [
		lit("820"),
		S(2),
		D(4, 5),
		rev(S(1), A(1))
	], "820-01234-A", "820-01234"),
	shape("schematic-051", "Apple schematic number (051-, four or five digits); pairs with the 820 number through title blocks", "apple", 80, "names-title", [
		lit("051"),
		S(2),
		D(4, 5)
	], "051-9876", "051-9876"),
	shape("la-code", "Compal board code (LA-, four characters, P)", "compal", 85, "all", [
		lit("LA"),
		S(1),
		X(4, 4, { digits: 1 }),
		lit("P")
	], "LA-Z123P", "LA-Z123P"),
	shape("la-code-nop", "Compal board code without the trailing P (LA-, four characters with two or more digits)", "compal", 60, "names-title", [
		lit("LA"),
		S(1),
		X(4, 4, { digits: 2 })
	], "LA-1234", "LA-1234"),
	shape("nm-code", "LCFC board code (NM-, one letter, three digits)", "lcfc", 85, "all", [
		lit("NM"),
		S(1),
		A(1),
		D(3)
	], "NM-Z123", "NM-Z123"),
	shape("da0-code", "Quanta board code (DA0, three characters, MB, three characters)", "quanta", 90, "all", [
		lit("DA0"),
		X(3, 3),
		lit("MB"),
		X(3, 3, { digits: 1 })
	], "DA0ZZ1MB6E0", "DA0ZZ1MB6E0"),
	shape("da0-sub", "Quanta sub-board code (DA0, three characters, two letters, three characters)", "quanta", 60, "all", [
		lit("DA0"),
		X(3, 3),
		A(2),
		X(3, 3, { digits: 1 })
	], "DA0ZZ1HB6E0", "DA0ZZ1HB6E0", { provisional: true }),
	shape("dotted-48", "Wistron board code (two or three digits, dot, five characters, dot, three or four characters)", "wistron", 60, "all", [
		D(2, 3),
		dot(),
		X(5, 5, {
			first: "D",
			letters: 1,
			digits: 2
		}),
		dot(),
		X(3, 4, { digits: 1 })
	], "48.4ZZ01.011", "48.4ZZ01.011"),
	shape("inventec-6050a", "Inventec board code (6050A and seven digits, optional -MB- revision)", "inventec", 85, "all", [
		lit("6050A"),
		D(7),
		rev(S(1), lit("MB"), S(1), X(3, 3, {
			first: "A",
			digits: 2
		}))
	], "6050A2999901-MB-A02", "6050A2999901"),
	shape("ms-code", "MSI board code (MS-, four or five characters starting with a digit)", "msi", 55, "names-title", [
		lit("MS"),
		S(1),
		X(4, 5, {
			first: "D",
			digits: 2
		})
	], "MS-17Z9", "MS-17Z9"),
	shape("samsung-ba", "Samsung assembly code for notebook boards (BA41, BA59, BA92 or BA94, five digits, optional letter)", "samsung", 80, "all", [
		alt("BA41", "BA59", "BA92", "BA94"),
		S(2),
		D(5),
		opt(A(1))
	], "BA41-01234A", "BA41-01234A"),
	shape("samsung-bn", "Samsung assembly code for television boards (BN41, BN44 or BN94, five digits, optional letter)", "samsung", 70, "all", [
		alt("BN41", "BN44", "BN94"),
		S(2),
		D(5),
		opt(A(1))
	], "BN44-00123A", "BN44-00123A", {
		device: "monitor",
		provisional: true
	}),
	shape("amd-109", "AMD graphics board number (109-, one letter, five digits, two digits)", "amd", 70, "all", [
		lit("109"),
		S(2),
		A(1),
		D(5),
		S(1),
		D(2)
	], "109-Z12345-00", "109-Z12345-00", { device: "gpu" }),
	shape("nvidia-699", "NVIDIA graphics board number (600- or 699-, digit letter three digits, four digits, three digits)", "nvidia", 65, "all", [
		alt("600", "699"),
		S(1),
		D(1),
		A(1),
		D(3),
		S(1),
		D(4),
		S(1),
		D(3)
	], "699-1Z123-0123-456", "699-1Z123-0123-456", {
		device: "gpu",
		provisional: true
	}),
	shape("cn-dell", "Dell part number with its country code (CN-0 and five characters)", "dell", 55, "names-title", [
		alt("CN", "TW", "MX", "PH", "MY", "TH", "BR"),
		S(1),
		lit("0"),
		X(5, 5, {
			digits: 1,
			letters: 1
		})
	], "CN-0ZZ123", "CN-0ZZ123"),
	shape("model-sm", "Samsung phone or tablet model (SM-, one letter, three digits, one or two characters)", "samsung", 65, "names-title", [
		lit("SM"),
		S(1),
		A(1),
		D(3),
		A(1),
		opt(X(1))
	], "SM-Z999F", "SM-Z999F", { identifies: "model" }),
	shape("model-gt", "Samsung phone model of the older series (GT-, one letter, four digits, optional letter)", "samsung", 55, "names-title", [
		lit("GT"),
		S(1),
		A(1),
		D(4),
		opt(A(1))
	], "GT-Z9999", "GT-Z9999", {
		provisional: true,
		identifies: "model"
	}),
	shape("model-a4", "Apple model number (A and four digits); collides with reference designators, so only in names and with a device word", "apple", 40, "names", [lit("A"), D(4)], "A9999", "A9999", {
		needsDeviceWord: true,
		identifies: "model"
	}),
	shape("generic-mb", "Generic main board label (MB, M/B or MAINBOARD with a code of four to eight characters)", void 0, 35, "names", [
		alt("MAINBOARD", "MB", "M/B"),
		S(1),
		X(4, 8, {
			digits: 1,
			letters: 1
		})
	], "MB-ZQ12", "MB-ZQ12"),
	shape("asus-60n", "ASUS board code (60N, one letter, 0, three characters, MB, four digits)", "asus", 65, "all", [
		lit("60N"),
		A(1),
		lit("0"),
		X(3, 3),
		S(1),
		lit("MB"),
		D(4)
	], "60NB0ZZ0-MB1201", "60NB0ZZ0-MB1201", { provisional: true }),
	shape("lenovo-fru", "Lenovo field-replaceable unit number (5B, two digits, one letter, five digits)", "lenovo", 55, "names-title", [
		lit("5B"),
		D(2),
		A(1),
		D(5)
	], "5B20Z12345", "5B20Z12345", { provisional: true }),
	shape("hp-spare", "HP spare part number (one letter, five digits, dash, three digits)", "hp", 50, "names-title", [
		alt("J", "K", "L", "M", "N", "P"),
		D(5),
		S(1),
		D(3)
	], "L12345-601", "L12345-601", { provisional: true }),
	shape("sony-console", "Sony console model (CUH, CFI, CECH or SCPH, four digits, optional letters)", "sony", 65, "names-title", [
		alt("CUH", "CFI", "CECH", "SCPH"),
		S(1),
		D(4),
		opt(A(1, 2))
	], "CUH-1234A", "CUH-1234A", {
		device: "console",
		provisional: true,
		identifies: "model"
	})
];
/** Scope groups: which recognition scopes may read a shape. */
function scopeAllows(group, scope) {
	if (group === "all") return true;
	if (group === "names") return scope === "name" || scope === "folder" || scope === "archive";
	return scope !== "body";
}
//#endregion
//#region src/lib/library/knowledge/lexicon.ts
var VENDORS = [
	{
		id: "apple",
		name: "Apple",
		kind: "brand",
		words: ["apple"],
		lines: [
			"mac",
			"macbook",
			"imac",
			"iphone",
			"ipad",
			"macmini",
			"mac mini",
			"airpods",
			"macpro",
			"mac pro",
			"applewatch"
		]
	},
	{
		id: "dell",
		name: "Dell",
		kind: "brand",
		words: ["dell"],
		lines: [
			"latitude",
			"inspiron",
			"optiplex",
			"vostro",
			"alienware",
			"xps"
		]
	},
	{
		id: "hp",
		name: "HP",
		kind: "brand",
		words: ["hewlett packard", "hewlett-packard"],
		weak: ["hp"],
		lines: [
			"elitebook",
			"probook",
			"pavilion",
			"zbook",
			"omen",
			"spectre",
			"compaq"
		]
	},
	{
		id: "lenovo",
		name: "Lenovo",
		kind: "brand",
		words: ["lenovo"],
		lines: [
			"thinkpad",
			"ideapad",
			"thinkcentre",
			"thinkbook"
		]
	},
	{
		id: "asus",
		name: "ASUS",
		kind: "brand",
		words: ["asus", "asustek"],
		lines: [
			"zenbook",
			"vivobook",
			"rog",
			"tuf",
			"zenfone"
		]
	},
	{
		id: "acer",
		name: "Acer",
		kind: "brand",
		words: ["acer"],
		lines: ["aspire", "travelmate"]
	},
	{
		id: "msi",
		name: "MSI",
		kind: "brand",
		words: ["msi", "micro-star"]
	},
	{
		id: "samsung",
		name: "Samsung",
		kind: "brand",
		words: ["samsung"],
		lines: ["galaxy", "galaxybook"]
	},
	{
		id: "sony",
		name: "Sony",
		kind: "brand",
		words: ["sony"],
		lines: [
			"vaio",
			"playstation",
			"xperia"
		]
	},
	{
		id: "toshiba",
		name: "Toshiba",
		kind: "brand",
		words: ["toshiba", "dynabook"],
		lines: ["tecra", "portege"]
	},
	{
		id: "fujitsu",
		name: "Fujitsu",
		kind: "brand",
		words: ["fujitsu"],
		lines: ["lifebook", "esprimo"]
	},
	{
		id: "microsoft",
		name: "Microsoft",
		kind: "brand",
		words: ["microsoft"],
		lines: [
			"surface pro",
			"surface laptop",
			"surface book",
			"surface go",
			"xbox"
		]
	},
	{
		id: "huawei",
		name: "Huawei",
		kind: "brand",
		words: ["huawei"],
		lines: ["matebook"]
	},
	{
		id: "honor",
		name: "Honor",
		kind: "brand",
		words: ["honor"],
		lines: ["magicbook"]
	},
	{
		id: "xiaomi",
		name: "Xiaomi",
		kind: "brand",
		words: ["xiaomi"],
		lines: ["redmi"]
	},
	{
		id: "oppo",
		name: "Oppo",
		kind: "brand",
		words: ["oppo"]
	},
	{
		id: "vivo",
		name: "Vivo",
		kind: "brand",
		words: ["vivo"]
	},
	{
		id: "oneplus",
		name: "OnePlus",
		kind: "brand",
		words: ["oneplus"]
	},
	{
		id: "google",
		name: "Google",
		kind: "brand",
		words: ["google"]
	},
	{
		id: "motorola",
		name: "Motorola",
		kind: "brand",
		words: ["motorola"]
	},
	{
		id: "nokia",
		name: "Nokia",
		kind: "brand",
		words: ["nokia"]
	},
	{
		id: "lg",
		name: "LG",
		kind: "brand",
		words: ["lge"],
		weak: ["lg"]
	},
	{
		id: "panasonic",
		name: "Panasonic",
		kind: "brand",
		words: ["panasonic"],
		lines: ["toughbook"]
	},
	{
		id: "razer",
		name: "Razer",
		kind: "brand",
		words: ["razer"]
	},
	{
		id: "gigabyte",
		name: "Gigabyte",
		kind: "brand",
		words: ["gigabyte"],
		lines: ["aorus"]
	},
	{
		id: "asrock",
		name: "ASRock",
		kind: "brand",
		words: ["asrock"]
	},
	{
		id: "evga",
		name: "EVGA",
		kind: "brand",
		words: ["evga"]
	},
	{
		id: "nintendo",
		name: "Nintendo",
		kind: "brand",
		words: ["nintendo"],
		lines: ["gameboy"]
	},
	{
		id: "valve",
		name: "Valve",
		kind: "brand",
		words: ["steam deck", "steamdeck"]
	},
	{
		id: "nvidia",
		name: "NVIDIA",
		kind: "chip-maker",
		words: ["nvidia"],
		lines: ["geforce"]
	},
	{
		id: "amd",
		name: "AMD",
		kind: "chip-maker",
		words: ["amd"],
		lines: ["radeon", "ryzen"]
	},
	{
		id: "intel",
		name: "Intel",
		kind: "chip-maker",
		words: ["intel"]
	},
	{
		id: "compal",
		name: "Compal",
		kind: "odm",
		words: ["compal"]
	},
	{
		id: "quanta",
		name: "Quanta",
		kind: "odm",
		words: ["quanta"]
	},
	{
		id: "wistron",
		name: "Wistron",
		kind: "odm",
		words: ["wistron"]
	},
	{
		id: "inventec",
		name: "Inventec",
		kind: "odm",
		words: ["inventec"]
	},
	{
		id: "pegatron",
		name: "Pegatron",
		kind: "odm",
		words: ["pegatron"]
	},
	{
		id: "foxconn",
		name: "Foxconn",
		kind: "odm",
		words: [
			"foxconn",
			"hon hai",
			"honhai"
		]
	},
	{
		id: "lcfc",
		name: "LCFC",
		kind: "odm",
		words: ["lcfc"]
	},
	{
		id: "clevo",
		name: "Clevo",
		kind: "odm",
		words: ["clevo"]
	},
	{
		id: "wingtech",
		name: "Wingtech",
		kind: "odm",
		words: ["wingtech"]
	},
	{
		id: "huaqin",
		name: "Huaqin",
		kind: "odm",
		words: ["huaqin"]
	},
	{
		id: "longcheer",
		name: "Longcheer",
		kind: "odm",
		words: ["longcheer"]
	},
	{
		id: "arima",
		name: "Arima",
		kind: "odm",
		words: ["arima"]
	},
	{
		id: "kinpo",
		name: "Kinpo",
		kind: "odm",
		words: ["kinpo"]
	}
];
var DEVICES = [
	{
		id: "laptop",
		words: [
			"laptop",
			"notebook",
			"netbook",
			"ultrabook",
			"chromebook",
			"ordinateur portable",
			"pc portable",
			"portatile",
			"prenosny pocitac",
			"ноутбук",
			"laptopy",
			"notebooky"
		],
		lines: [
			"macbook",
			"thinkpad",
			"ideapad",
			"latitude",
			"elitebook",
			"probook",
			"zenbook",
			"vivobook",
			"travelmate",
			"thinkbook",
			"matebook",
			"galaxybook",
			"lifebook",
			"toughbook"
		]
	},
	{
		id: "phone",
		words: [
			"phone",
			"smartphone",
			"cellphone",
			"handset",
			"mobiltelefon",
			"okostelefon",
			"telefon",
			"telephone",
			"telefono",
			"cellulare",
			"smartfon",
			"смартфон",
			"телефон",
			"мобільний телефон"
		],
		weak: [
			"mobile",
			"mobil",
			"handy"
		],
		lines: [
			"iphone",
			"xperia",
			"zenfone",
			"redmi"
		]
	},
	{
		id: "tablet",
		words: [
			"tablet",
			"tablette",
			"tablagep",
			"планшет",
			"tablet pc"
		],
		lines: ["ipad"]
	},
	{
		id: "desktop-board",
		words: [
			"atx",
			"matx",
			"mini itx",
			"desktop board",
			"desktop motherboard"
		],
		weak: [
			"motherboard",
			"mainboard",
			"mobo",
			"alaplap",
			"hauptplatine",
			"carte mere",
			"scheda madre",
			"zakladna doska",
			"płyta główna",
			"материнська плата",
			"desktop",
			"itx"
		],
		lines: [
			"optiplex",
			"esprimo",
			"thinkcentre"
		]
	},
	{
		id: "all-in-one",
		words: ["all in one", "all-in-one"],
		weak: ["aio"],
		lines: ["imac"]
	},
	{
		id: "gpu",
		words: [
			"gpu",
			"graphics card",
			"video card",
			"videokarte",
			"grafikkarte",
			"carte graphique",
			"scheda video",
			"graficka karta",
			"karta graficzna",
			"відеокарта",
			"videokartya",
			"grafikus kartya",
			"rtx",
			"gtx"
		],
		weak: ["vga"],
		lines: ["geforce", "radeon"]
	},
	{
		id: "console",
		words: [
			"console",
			"konzol",
			"konsole",
			"konzola",
			"konsola",
			"консоль",
			"ps3",
			"ps4",
			"ps5",
			"psp",
			"xbox",
			"playstation",
			"nintendo",
			"steam deck"
		],
		lines: ["playstation", "gameboy"]
	},
	{
		id: "monitor",
		words: [
			"monitor",
			"tv",
			"television",
			"televizor",
			"fernseher",
			"televisore",
			"telewizor",
			"телевізор",
			"lcd tv",
			"led tv"
		]
	},
	{
		id: "psu",
		words: [
			"psu",
			"power supply",
			"netzteil",
			"alimentation",
			"alimentatore",
			"tapegyseg",
			"zasilacz",
			"zdroj",
			"блок живлення"
		]
	}
];
var DOCUMENTS = [
	{
		id: "board",
		words: [
			"boardview",
			"board view",
			"boardviewer",
			"brd"
		],
		weak: ["bv"],
		extensions: [
			"brd",
			"brd2",
			"bdv",
			"bvr",
			"bv",
			"fz",
			"cad",
			"tvw",
			"cst",
			"asc",
			"xzz",
			"pcb",
			"pcbdoc",
			"kicad_pcb"
		]
	},
	{
		id: "schematic",
		words: [
			"schematic",
			"schematics",
			"schematic diagram",
			"circuit diagram",
			"electrical diagram",
			"schaltplan",
			"schema",
			"schemat",
			"схема",
			"kapcsolasi rajz",
			"schematy",
			"sch"
		],
		weak: ["rajz", "diagram"],
		extensions: [
			"sch",
			"schdoc",
			"kicad_sch",
			"dsn"
		]
	},
	{
		id: "board-pdf",
		words: [
			"assembly drawing",
			"pcb layout",
			"placement drawing",
			"component placement"
		],
		weak: ["assembly", "layout"]
	},
	{
		id: "datasheet",
		words: [
			"datasheet",
			"datasheets",
			"data sheet",
			"datenblatt",
			"fiche technique",
			"scheda tecnica",
			"adatlap",
			"katalogovy list",
			"karta katalogowa",
			"даташит"
		]
	},
	{
		id: "service-manual",
		words: [
			"service manual",
			"servicemanual",
			"repair manual",
			"repair guide",
			"disassembly",
			"hardware maintenance manual",
			"servicehandbuch",
			"manuel de service",
			"manuale di servizio",
			"instrukcja serwisowa",
			"szerviz kezikonyv",
			"szervizkezikonyv",
			"servisna prirucka",
			"сервісний посібник"
		],
		weak: ["manual"]
	},
	{
		id: "bom",
		words: [
			"bom",
			"bill of materials",
			"parts list",
			"partslist",
			"stuckliste",
			"nomenclature",
			"distinta base",
			"kusovnik",
			"anyagjegyzek",
			"специфікація"
		],
		weakExtensions: [
			"csv",
			"xls",
			"xlsx"
		]
	},
	{
		id: "photo",
		words: [
			"photo",
			"photos",
			"foto",
			"fotka"
		],
		weak: [
			"image",
			"pic",
			"img"
		],
		extensions: [
			"jpg",
			"jpeg",
			"png",
			"bmp",
			"tif",
			"tiff",
			"heic",
			"webp",
			"gif"
		]
	},
	{
		id: "thermal",
		words: [
			"thermal",
			"thermogram",
			"hokamera",
			"warmebild",
			"wärmebild",
			"flir"
		]
	},
	{
		id: "firmware",
		words: [
			"bios",
			"firmware",
			"uefi",
			"ec firmware"
		],
		weak: ["eeprom", "spi"],
		extensions: [
			"rom",
			"cap",
			"fd",
			"bio",
			"bin"
		]
	}
];
//#endregion
//#region src/lib/library/knowledge/hints.ts
/**
* Vendor, device-type and document-type hints from names and titles.
*
* A hint is a guess from words, never a fact: it says which lexicon entry matched, where (a span of the original text), and
* how sure the match is (0..100). The Library keeps the hints with their source and decides later; "unknown" is a valid
* answer and the absence of a hint is not an error.
*
* Matching rules (all linear: the text is cut into alphanumeric runs once and every run is looked at a constant number of
* times; there is no regular expression over the text):
*  - a run is lower-cased with the accents removed; runs longer than 64 units are skipped;
*  - a phrase of two or three words matches when the words are separated by exactly one blank, "-", "_" or "."; the longest
*    phrase at a position wins and the words it consumed are not looked at again;
*  - a run followed by digits matches by its leading letters ("rtx3060" is "rtx", "macbookpro11" starts with "macbook");
*  - product-line stems of seven letters or more also match as a start of a longer word ("macbookpro"); shorter lines only
*    match whole words;
*  - confidence: vendor name 90, ODM name 85, weak vendor word 55, product line 65; device word 80, weak 50, product line 65;
*    document word 80, weak 45, strong extension 85, weak extension 35.
*
* The word lists are in `lexicon.ts` (CC0).
*/
var PHRASE_SEPARATORS = /[\s\-_.]+/g;
var MIN_STEM = 7;
function phraseKey(entry) {
	return lexiconKey(entry).replace(PHRASE_SEPARATORS, " ").trim();
}
function compile(entries) {
	const exact = /* @__PURE__ */ new Map(), stems = /* @__PURE__ */ new Map();
	let maxWords = 1;
	for (const entry of entries) for (const [words, confidence, basis] of entry.groups) for (const word of words ?? []) {
		const key = phraseKey(word);
		if (key === "") continue;
		const value = {
			id: entry.id,
			confidence,
			basis,
			kind: entry.kind
		};
		const known = exact.get(key);
		if (!known || known.confidence < confidence) exact.set(key, value);
		maxWords = Math.max(maxWords, key.split(" ").length);
		if (basis === "line" && key.length >= MIN_STEM && !key.includes(" ")) stems.set(key, value);
	}
	return {
		exact,
		stems,
		maxWords: Math.min(maxWords, 3)
	};
}
var vendorLexicon = () => vendorCompiled ??= compile(VENDORS.map((entry) => ({
	id: entry.id,
	kind: entry.kind,
	groups: [
		[
			entry.words,
			entry.kind === "odm" ? 85 : 90,
			"name"
		],
		[
			entry.weak,
			55,
			"weak"
		],
		[
			entry.lines,
			65,
			"line"
		]
	]
})));
var deviceLexicon = () => deviceCompiled ??= compile(DEVICES.map((entry) => ({
	id: entry.id,
	groups: [
		[
			entry.words,
			80,
			"name"
		],
		[
			entry.weak,
			50,
			"weak"
		],
		[
			entry.lines,
			65,
			"line"
		]
	]
})));
var documentLexicon = () => documentCompiled ??= compile(DOCUMENTS.map((entry) => ({
	id: entry.id,
	groups: [[
		entry.words,
		80,
		"name"
	], [
		entry.weak,
		45,
		"weak"
	]]
})));
var vendorCompiled;
var deviceCompiled;
var documentCompiled;
var MAX_RUNS = 2e4;
/** The alphanumeric runs of the text with their keys, and for each run whether exactly one phrase separator joins it to the next. */
function runsOf(text, length, meter) {
	const runs = [], joined = [];
	let index = 0;
	while (index < length && runs.length < MAX_RUNS) {
		if (!isWordCode(text.charCodeAt(index))) {
			index++;
			continue;
		}
		const start = index;
		while (index < length && isWordCode(text.charCodeAt(index))) index++;
		tick(meter, index - start + 1);
		if (index - start > 64) continue;
		const key = lexiconKey(text.slice(start, index));
		let letters = key.length;
		for (let at = 0; at < key.length; at++) {
			const unit = key.charCodeAt(at);
			if (unit >= 48 && unit <= 57) {
				letters = at;
				break;
			}
		}
		if (runs.length > 0) {
			const previous = runs[runs.length - 1];
			const gap = start - previous.end;
			const separator = gap === 1 ? text.charCodeAt(previous.end) : -1;
			joined[runs.length - 1] = gap === 1 && (separator === 32 || separator === 45 || separator === 95 || separator === 46 || separator === 160);
		}
		runs.push({
			start,
			end: index,
			key,
			letters: letters === key.length ? key : key.slice(0, letters)
		});
	}
	if (runs.length > 0) joined[runs.length - 1] = false;
	return {
		runs,
		joined
	};
}
function findHints(text, lexicon, options) {
	const length = scanLength(text);
	if (length === 0) return [];
	const { runs, joined } = runsOf(text, length, options?.meter);
	const found = [];
	let index = 0;
	while (index < runs.length && found.length < 256) {
		let hit, used = 1, word = "";
		for (let words = Math.min(lexicon.maxWords, runs.length - index); words >= 2 && !hit; words--) {
			let ok = true, key = runs[index].key;
			for (let step = 1; step < words; step++) {
				if (!joined[index + step - 1]) {
					ok = false;
					break;
				}
				key += " " + runs[index + step].key;
			}
			if (!ok) continue;
			const candidate = lexicon.exact.get(key);
			if (candidate) {
				hit = candidate;
				used = words;
				word = key;
			}
		}
		if (!hit) {
			const run = runs[index];
			hit = lexicon.exact.get(run.key);
			word = run.key;
			if (!hit && run.letters !== run.key) {
				hit = lexicon.exact.get(run.letters);
				word = run.letters;
			}
			if (!hit) {
				const top = Math.min(run.letters.length, 12);
				for (let size = top; size >= MIN_STEM && !hit; size--) {
					const stem = lexicon.stems.get(run.letters.slice(0, size));
					if (stem) {
						hit = stem;
						word = run.letters.slice(0, size);
					}
				}
			}
		}
		if (hit) found.push({
			id: hit.id,
			confidence: hit.confidence,
			basis: hit.basis,
			word,
			start: runs[index].start,
			end: runs[index + used - 1].end,
			kind: hit.kind
		});
		index += used;
	}
	return found;
}
/** Vendors named in the text: the vendor's own names, weak two-letter names and product lines. */
function vendorHints(text, options) {
	return findHints(text, vendorLexicon(), options).map((hint) => ({
		...hint,
		kind: hint.kind ?? "brand"
	}));
}
/** Device types named in the text (laptop, phone, tablet, desktop board, GPU, console, monitor, PSU), in the eight interface languages. */
function deviceTypeHints(text, options) {
	return findHints(text, deviceLexicon(), options).map(({ kind: _kind, ...hint }) => hint);
}
/** The extension of a file name without its dot, lower case, or '' (the part after the last dot of the last 16 units). */
function extensionOf(name) {
	if (typeof name !== "string") return "";
	const end = Math.min(name.length, MAX_TEXT_LENGTH);
	const stop = Math.max(0, end - 17);
	for (let index = end - 1; index >= stop; index--) {
		const code = name.charCodeAt(index);
		if (code === 46) return index === end - 1 || index === 0 ? "" : name.slice(index + 1, end).toLowerCase();
		if (code === 47 || code === 92) return "";
	}
	return "";
}
var EXTENSION_HINTS = (() => {
	const map = /* @__PURE__ */ new Map();
	for (const entry of DOCUMENTS) for (const extension of entry.extensions ?? []) map.set(extension, {
		id: entry.id,
		confidence: 85,
		basis: "extension"
	});
	for (const entry of DOCUMENTS) for (const extension of entry.weakExtensions ?? []) if (!map.has(extension)) map.set(extension, {
		id: entry.id,
		confidence: 35,
		basis: "weak-extension"
	});
	return map;
})();
/** The document type an extension (with or without the dot, any case) suggests, or undefined. A `.pdf` suggests nothing. */
function documentTypeForExtension(extension) {
	if (typeof extension !== "string" || extension.length > 16) return void 0;
	const key = (extension.charCodeAt(0) === 46 ? extension.slice(1) : extension).toLowerCase();
	const entry = EXTENSION_HINTS.get(key);
	return entry ? {
		id: entry.id,
		confidence: entry.confidence,
		basis: entry.basis,
		word: key,
		start: 0,
		end: 0
	} : void 0;
}
/** Document types named in the text, plus the one the extension suggests. */
function documentTypeHints(text, options) {
	const hints = findHints(text, documentLexicon(), options).map(({ kind: _kind, ...hint }) => hint);
	const extension = options?.extension ?? extensionOf(text);
	const fromExtension = extension ? documentTypeForExtension(extension) : void 0;
	if (fromExtension) hints.push(fromExtension);
	return hints;
}
/** Groups hints by id: strongest confidence first, with a small bonus for repeated evidence. */
function summarizeHints(hints) {
	const byId = /* @__PURE__ */ new Map();
	for (const hint of hints) {
		const known = byId.get(hint.id);
		if (!known) byId.set(hint.id, {
			id: hint.id,
			confidence: hint.confidence,
			count: 1
		});
		else {
			known.count++;
			known.confidence = Math.max(known.confidence, hint.confidence);
		}
	}
	const out = Array.from(byId.values());
	for (const summary of out) summary.confidence = Math.min(99, summary.confidence + Math.min(10, 3 * (summary.count - 1)));
	return out.sort((a, b) => b.confidence - a.confidence || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
//#endregion
//#region src/lib/library/knowledge/board-numbers.ts
/**
* Board-number recognition: finds the numbers that identify a board in a file name, a folder name, an archive name, a PDF
* title block, a PDF's title or outline, or the header text of a board file.
*
* What it returns: for each number a shape id (`BOARD_NUMBER_SHAPES`), the normalised form (upper case, "-" as the
* separator, a trailing revision letter split off), a confidence (0..100), the evidence span `[start, end)` in the original
* text, and the vendor the shape belongs to. Nothing is guessed from a number's digits; a shape is a published convention
* for the layout of a number, not a database of numbers.
*
* Precision comes first. A candidate is dropped when
*  - it does not stand alone: a letter or digit touches it on either side (`X820-01234`, `820-012345`);
*  - its shape may not be read in this scope (`scopes` of the shape: a shape that collides with reference designators is only
*    read in names, and only when a device word stands in the same text);
*  - a numeric shape continues into more digit groups (`820-01234-56`, `051-9876.5`): a date, a version or a phone number;
*  - a numeric shape was written with a blank or an underscore and its last group reads as a year (`051 2019`);
*  - it looks like a phone number: a "+" in front, a word like tel or fax just before it, or the last group of four digits or
*    fewer joined by dashes or dots to other short groups so that ten or more digits run on.
* Reference designators (`U7000`), page and sheet numbers (`Sheet 3 of 12`, `p. 12`), dates (`2024-10-07`) and ordinary part
* numbers (`TPS51225`) match no shape at all.
*
* Confidence = the shape's base confidence, +5 when a label word (board, PCB, P/N, DWG, MLB ...) stands within 24 characters
* before the number, -10 for a blank or underscore in place of the dash, -15 in OCR text, -10 in running text. When two shapes
* claim overlapping text the one with the higher confidence, then the longer one, wins.
*
* Linear time: the text is scanned once; a candidate starts only at the beginning of an alphanumeric run and is tried against
* the (constant number of) shapes whose first character fits, each attempt reading at most 32 characters. At most
* `MAX_TEXT_LENGTH` units are read and at most `MAX_MATCHES` numbers returned.
*/
function matchSegments(segments, text, length, from, state) {
	let pos = from;
	for (const segment of segments) switch (segment.t) {
		case "lit": {
			const value = segment.v;
			for (let k = 0; k < value.length; k++) if (foldedAt(text, pos + k, length) !== value.charCodeAt(k)) return -1;
			state.out += value;
			pos += value.length;
			break;
		}
		case "alt": {
			let taken = "";
			for (const option of segment.v) {
				let ok = true;
				for (let k = 0; k < option.length; k++) if (foldedAt(text, pos + k, length) !== option.charCodeAt(k)) {
					ok = false;
					break;
				}
				if (ok) {
					taken = option;
					break;
				}
			}
			if (taken === "") return -1;
			state.out += taken;
			pos += taken.length;
			break;
		}
		case "D":
		case "A":
		case "X": {
			let count = 0, digits = 0, letters = 0, run = "";
			while (count < segment.max) {
				const code = foldedAt(text, pos + count, length);
				const isDigit = isDigitCode(code), isLetter = isLetterCode(code);
				if (segment.t === "D" ? !isDigit : segment.t === "A" ? !isLetter : !(isDigit || isLetter)) break;
				if (isDigit) digits++;
				else letters++;
				run += String.fromCharCode(code);
				count++;
			}
			if (count < segment.min) return -1;
			if (segment.digits !== void 0 && digits < segment.digits) return -1;
			if (segment.letters !== void 0 && letters < segment.letters) return -1;
			if (segment.first !== void 0 && (segment.first === "D" ? !isDigitCode(run.charCodeAt(0)) : !isLetterCode(run.charCodeAt(0)))) return -1;
			state.out += run;
			state.lastRun = run;
			pos += count;
			break;
		}
		case "S": {
			const code = foldedAt(text, pos, length);
			if (code === 45) {} else if (segment.loose >= 1 && code === 95) state.loose = true;
			else if (segment.loose === 2 && code === 32) state.loose = true;
			else return -1;
			state.out += "-";
			pos++;
			break;
		}
		case "dot":
			if (foldedAt(text, pos, length) !== 46) return -1;
			state.out += ".";
			pos++;
			break;
		case "opt": {
			if (state.skipOptional) break;
			const saved = { ...state };
			const end = matchSegments(segment.segs, text, length, pos, state);
			if (end < 0) {
				Object.assign(state, saved);
				break;
			}
			if (segment.revision) {
				state.revision = state.lastRun;
				state.out = saved.out;
				state.lastRun = saved.lastRun;
				state.loose = saved.loose;
			}
			pos = end;
			break;
		}
	}
	return pos;
}
var NO_FIRST = /* @__PURE__ */ new Uint8Array(128);
var FIRST_CODES = new Map(BOARD_NUMBER_SHAPES.map((item) => {
	const table = /* @__PURE__ */ new Uint8Array(128);
	const first = item.segments[0];
	const mark = (code) => {
		if (code < 128) table[code] = 1;
	};
	if (first.t === "lit") mark(first.v.charCodeAt(0));
	else if (first.t === "alt") for (const option of first.v) mark(option.charCodeAt(0));
	else if (first.t === "D" || first.t === "X") for (let code = 48; code <= 57; code++) mark(code);
	if (first.t === "A" || first.t === "X") for (let code = 65; code <= 90; code++) mark(code);
	return [item.id, table];
}));
/** Shapes with an optional trailing group. */
var HAS_OPTIONAL = new Set(BOARD_NUMBER_SHAPES.filter((item) => item.segments.some((segment) => segment.t === "opt")).map((item) => item.id));
/** True when the shape consists of digits and separators only (a number a date or a phone number could imitate). */
var NUMERIC_SHAPE = new Set(BOARD_NUMBER_SHAPES.filter((item) => item.segments.every((segment) => segment.t === "S" || segment.t === "D" || segment.t === "dot" || segment.t === "opt" || segment.t === "lit" && /^[0-9]+$/.test(segment.v))).map((item) => item.id));
var LABEL_WORDS = /* @__PURE__ */ new Set([
	"BOARD",
	"PCB",
	"PN",
	"P/N",
	"DWG",
	"MLB",
	"MB",
	"MAINBOARD",
	"MOTHERBOARD",
	"LOGIC",
	"SCHEMATIC",
	"SCH",
	"MODEL",
	"ASSY",
	"BRD",
	"NUMBER",
	"NO",
	"REF"
]);
var PHONE_WORDS = /* @__PURE__ */ new Set([
	"TEL",
	"PHONE",
	"FAX",
	"CALL",
	"GSM",
	"HOTLINE",
	"TELEFON",
	"TELEFONE",
	"MOB"
]);
var LABEL_WINDOW = 24;
var PHONE_WINDOW = 14;
/** Words (runs of letters, digits and "/") in the `window` folded units before `start`. */
function wordsBefore(text, length, start, window) {
	const words = [];
	let current = "";
	for (let index = Math.max(0, start - window); index < start; index++) {
		const code = foldedAt(text, index, length);
		if (isAlnumCode(code) || code === 47) current += String.fromCharCode(code);
		else if (current !== "") {
			words.push(current);
			current = "";
		}
	}
	if (current !== "") words.push(current);
	return words;
}
function hasLabel(text, length, start) {
	for (const word of wordsBefore(text, length, start, LABEL_WINDOW)) if (LABEL_WORDS.has(word)) return true;
	return false;
}
/** Groups of up to four digits joined to the match by dashes or dots, counted to the left and to the right. */
function neighbourDigits(text, length, start, end) {
	let total = 0, groups = 0;
	let pos = start;
	while (groups < 4) {
		const separator = foldedAt(text, pos - 1, length);
		if (separator !== 45 && separator !== 46) break;
		let from = pos - 1;
		while (from > 0 && isDigitCode(foldedAt(text, from - 1, length)) && pos - 1 - from < 5) from--;
		const size = pos - 1 - from;
		if (size < 1 || size > 4 || from > 0 && isAlnumCode(foldedAt(text, from - 1, length))) break;
		total += size;
		groups++;
		pos = from;
	}
	pos = end;
	while (groups < 8) {
		const separator = foldedAt(text, pos, length);
		if (separator !== 45 && separator !== 46) break;
		let to = pos + 1;
		while (to < length && isDigitCode(foldedAt(text, to, length)) && to - pos - 1 < 5) to++;
		const size = to - pos - 1;
		if (size < 1 || size > 4 || isAlnumCode(foldedAt(text, to, length))) break;
		total += size;
		groups++;
		pos = to;
	}
	return total;
}
function looksLikePhone(text, length, start, end, digitsInMatch, lastGroupSize) {
	for (let at = start - 1, steps = 0; at >= 0 && steps < 24; at--, steps++) {
		const code = foldedAt(text, at, length);
		if (code === 43 && isDigitCode(foldedAt(text, at + 1, length))) return true;
		if (!(isDigitCode(code) || code === 32 || code === 45 || code === 46 || code === 40 || code === 41)) break;
	}
	let bracket = start - 1;
	if (foldedAt(text, bracket, length) === 32) bracket--;
	if (foldedAt(text, bracket, length) === 41) {
		let digits = 0;
		while (digits < 5 && isDigitCode(foldedAt(text, bracket - 1 - digits, length))) digits++;
		if (digits >= 1 && digits <= 4 && foldedAt(text, bracket - 1 - digits, length) === 40) return true;
	}
	for (const word of wordsBefore(text, length, start, PHONE_WINDOW)) if (PHONE_WORDS.has(word)) return true;
	return lastGroupSize <= 4 && digitsInMatch + neighbourDigits(text, length, start, end) >= 10;
}
function isYearLike(value) {
	if (value.length !== 4) return false;
	const year = Number(value);
	return year >= 1990 && year <= 2039;
}
function lastDigitGroup(text) {
	let end = text.length;
	while (end > 0 && !isDigitCode(text.charCodeAt(end - 1))) end--;
	let start = end;
	while (start > 0 && isDigitCode(text.charCodeAt(start - 1))) start--;
	return text.slice(start, end);
}
var SCOPE_ADJUST = {
	ocr: -15,
	body: -10
};
var LOOSE_PENALTY = 10;
var LABEL_BONUS = 5;
function clamp(value) {
	return Math.max(1, Math.min(99, Math.round(value)));
}
/**
* Finds the board numbers in `text`. Total: any input (also a non-string) gives an array. At most `MAX_MATCHES` results,
* sorted by position, none overlapping.
*/
function recognizeBoardNumbers(text, options = {}) {
	const length = scanLength(text);
	if (length === 0) return [];
	const scope = options.scope !== void 0 && RECOGNITION_SCOPES.includes(options.scope) ? options.scope : "name";
	const meter = options.meter;
	const shapes = BOARD_NUMBER_SHAPES.filter((item) => scopeAllows(item.scopes, scope));
	if (shapes.length === 0) return [];
	const candidates = [];
	let words;
	const hasDeviceWord = (vendor) => {
		words ??= {
			device: deviceTypeHints(text, { meter }).some((hint) => hint.confidence >= 50),
			vendors: new Set(vendorHints(text, { meter }).map((hint) => hint.id))
		};
		return words.device || vendor !== void 0 && words.vendors.has(vendor);
	};
	const accept = (item, state, index, end) => {
		const next = foldedAt(text, end, length);
		if (isAlnumCode(next)) return null;
		const numeric = NUMERIC_SHAPE.has(item.id);
		const last = foldedAt(text, end - 1, length);
		if (numeric && isDigitCode(last) && (next === 45 || next === 46) && isDigitCode(foldedAt(text, end + 1, length))) return null;
		const group = lastDigitGroup(state.out);
		if (numeric && state.loose && isYearLike(group)) return null;
		if (numeric && looksLikePhone(text, length, index, end, state.out.replace(/[^0-9]/g, "").length, group.length)) return null;
		if (item.needsDeviceWord && !hasDeviceWord(item.vendor)) return null;
		const labelled = hasLabel(text, length, index);
		return {
			shape: item,
			start: index,
			end,
			normalized: state.out,
			revision: state.revision,
			loose: state.loose,
			labelled,
			confidence: clamp(item.confidence + (labelled ? LABEL_BONUS : 0) - (state.loose ? LOOSE_PENALTY : 0) + (SCOPE_ADJUST[scope] ?? 0))
		};
	};
	let previousAlnum = false;
	for (let index = 0; index < length && candidates.length < 1024; index++) {
		tick(meter);
		const code = foldCode(text.charCodeAt(index));
		const alnum = isAlnumCode(code);
		const atStart = alnum && !previousAlnum;
		previousAlnum = alnum;
		if (!atStart) continue;
		for (const item of shapes) {
			if ((FIRST_CODES.get(item.id) ?? NO_FIRST)[code] !== 1) continue;
			for (const skipOptional of HAS_OPTIONAL.has(item.id) ? [false, true] : [true]) {
				const state = {
					out: "",
					revision: void 0,
					lastRun: "",
					loose: false,
					skipOptional
				};
				const end = matchSegments(item.segments, text, length, index, state);
				tick(meter, end < 0 ? 1 : end - index);
				if (end < 0) continue;
				const candidate = accept(item, state, index, end);
				if (candidate) {
					candidates.push(candidate);
					break;
				}
			}
		}
	}
	const ranked = candidates.slice().sort((a, b) => b.confidence - a.confidence || b.end - b.start - (a.end - a.start) || a.start - b.start);
	const chosen = [];
	for (const candidate of ranked) {
		if (chosen.length >= 256) break;
		if (chosen.every((other) => candidate.end <= other.start || candidate.start >= other.end)) chosen.push(candidate);
	}
	chosen.sort((a, b) => a.start - b.start);
	return chosen.map((candidate) => ({
		shape: candidate.shape.id,
		normalized: candidate.normalized,
		raw: text.slice(candidate.start, candidate.end),
		start: candidate.start,
		end: candidate.end,
		confidence: candidate.confidence,
		description: candidate.shape.description,
		...candidate.shape.vendor !== void 0 ? { vendor: candidate.shape.vendor } : {},
		...candidate.shape.device !== void 0 ? { device: candidate.shape.device } : {},
		...candidate.revision !== void 0 ? { revision: candidate.revision } : {},
		scope,
		loose: candidate.loose,
		labelled: candidate.labelled,
		provisional: candidate.shape.provisional === true
	}));
}
//#endregion
//#region src/lib/library/knowledge/revision.ts
/**
* Revision parser: finds board and document revisions in names, titles and title blocks, and orders them within one scheme.
*
* Forms read (case-insensitive, each must stand alone: no letter or digit touches it):
*  - a label word and a value: "REV A", "Rev.B", "REV: 02", "REVISION 1.0", "REV_A1", and the joined forms "REVA", "REV1.0";
*  - a revision that belongs to a board number: the "-A" of "820-01234-A" and the "-MB-A02" of an Inventec code;
*  - "R" and a dotted number: "R1.0", "R2.1" ("R1" alone is a reference designator and is not read);
*  - the build stages EVT, DVT, PVT and FVT with an optional number ("EVT2", "DVT-1"), and "MP" on its own;
*  - a version: "V2.5", "V1", "VER 3", "VERSION 1.2";
*  - a board word and a single letter: "MLB-A", "MB_B", "MAINBOARD C".
*
* Every result carries a scheme and a rank. The schemes are `letter` (A, B, AB), `alnum` (A01, B2), `number` (1, 2, 1.0, 2.1.3),
* `stage` (EVT before DVT before PVT before MP) and `version` (V2.5). Two revisions can only be ordered when they are in the
* same scheme (`compareRevisions`); across schemes the order is unknown and the caller says so. Normalised forms drop leading
* zeros ("REV 02" is "2", "A01" is "A1").
*
* Linear time: one pass over the alphanumeric runs of the text; each run is looked at a constant number of times and the
* value after a label is at most 8 characters. At most `MAX_TEXT_LENGTH` units are read and `MAX_MATCHES` results returned.
*/
var MAX_RUN = 32;
var STAGES = {
	EVT: 1,
	DVT: 2,
	FVT: 3,
	PVT: 4,
	MP: 5
};
/** Two-letter words that must not read as a revision ("REV IS ..."). */
var WORDS = /* @__PURE__ */ new Set([
	"AN",
	"AS",
	"AT",
	"BE",
	"BY",
	"DO",
	"GO",
	"HE",
	"IF",
	"IN",
	"IS",
	"IT",
	"ME",
	"MY",
	"NO",
	"OF",
	"ON",
	"OR",
	"SO",
	"TO",
	"UP",
	"US",
	"WE"
]);
var BOARD_WORDS = /* @__PURE__ */ new Set([
	"MLB",
	"MB",
	"MAINBOARD",
	"MOTHERBOARD"
]);
var stripZeros = (digits) => {
	const value = String(Number(digits));
	return value === "NaN" ? digits : value;
};
var base26 = (letters) => letters.length === 2 ? 26 * (letters.charCodeAt(0) - 64) + (letters.charCodeAt(1) - 64) : letters.charCodeAt(0) - 64;
/** The folded alphanumeric run that starts at `pos`, at most MAX_RUN long (longer runs have text ''). */
function runAt(text, length, pos) {
	let end = pos;
	let out = "";
	while (end < length) {
		const code = foldedAt(text, end, length);
		if (!isAlnumCode(code)) break;
		if (out.length <= MAX_RUN) out += String.fromCharCode(code);
		end++;
	}
	return {
		start: pos,
		end,
		text: out.length > MAX_RUN ? "" : out
	};
}
/** Reads a revision value at `pos`: digits with dotted groups, one or two letters, or letters and digits. Null when the text is not one. */
function readValue(text, length, pos) {
	const run = runAt(text, length, pos);
	const value = run.text;
	if (value === "" || value.length > 8) return null;
	let letters = 0;
	while (letters < value.length && isLetterCode(value.charCodeAt(letters))) letters++;
	if (letters === 0) {
		if (value.length > 3 || !/^[0-9]+$/.test(value)) return null;
		const parts = [stripZeros(value)];
		let end = run.end;
		while (parts.length < 3 && foldedAt(text, end, length) === 46 && isDigitCode(foldedAt(text, end + 1, length))) {
			const next = runAt(text, length, end + 1);
			if (next.text === "" || next.text.length > 3 || !/^[0-9]+$/.test(next.text)) break;
			parts.push(stripZeros(next.text));
			end = next.end;
		}
		return {
			end,
			raw: text.slice(pos, end),
			normalized: parts.join("."),
			scheme: "number",
			rank: parts.map(Number)
		};
	}
	if (letters > 2) return null;
	const letterPart = value.slice(0, letters), digitPart = value.slice(letters);
	if (digitPart === "") {
		if (letters === 2 && WORDS.has(letterPart)) return null;
		return {
			end: run.end,
			raw: text.slice(pos, run.end),
			normalized: letterPart,
			scheme: "letter",
			rank: [base26(letterPart)]
		};
	}
	if (digitPart.length > 2 || !/^[0-9]+$/.test(digitPart)) return null;
	return {
		end: run.end,
		raw: text.slice(pos, run.end),
		normalized: letterPart + stripZeros(digitPart),
		scheme: "alnum",
		rank: [base26(letterPart), Number(digitPart)]
	};
}
/** Skips up to three separator characters (blank . _ - :) after a label; returns the new position. */
function skipSeparators(text, length, pos) {
	let at = pos, count = 0;
	while (count < 3) {
		const code = foldedAt(text, at, length);
		if (code === 32 || code === 46 || code === 95 || code === 45 || code === 58) {
			at++;
			count++;
		} else break;
	}
	return at;
}
/**
* Reads the revisions in `text`, sorted by position. Total: any input gives an array.
*/
function parseRevisions(text, options = {}) {
	const length = scanLength(text);
	if (length === 0) return [];
	const meter = options.meter;
	const found = [];
	const add = (match) => {
		if (found.length < 256) found.push(match);
	};
	let index = 0;
	while (index < length && found.length < 256) {
		if (!isAlnumCode(foldedAt(text, index, length))) {
			index++;
			tick(meter);
			continue;
		}
		const run = runAt(text, length, index);
		tick(meter, run.end - index + 1);
		const word = run.text;
		let consumed = run.end;
		if (word !== "") {
			if (word === "REV" || word === "REVISION") {
				const at = skipSeparators(text, length, run.end);
				const value = at > run.end || foldedAt(text, run.end, length) === -1 ? readValue(text, length, at) : null;
				if (value) {
					add({
						raw: value.raw,
						normalized: value.normalized,
						scheme: value.scheme,
						rank: value.rank,
						basis: "label",
						confidence: value.scheme === "alnum" ? 85 : 90,
						start: index,
						end: value.end
					});
					consumed = value.end;
				}
			} else if (word.length > 3 && word.startsWith("REV") && word !== "REVISION") {
				const value = readValue(text, length, index + 3);
				if (value) {
					add({
						raw: value.raw,
						normalized: value.normalized,
						scheme: value.scheme,
						rank: value.rank,
						basis: "joined-label",
						confidence: 80,
						start: index,
						end: value.end
					});
					consumed = value.end;
				}
			} else if (word.length >= 2 && word.length <= 3 && word.charCodeAt(0) === 82 && /^R[0-9]{1,2}$/.test(word) && foldedAt(text, run.end, length) === 46 && isDigitCode(foldedAt(text, run.end + 1, length))) {
				const value = readValue(text, length, index + 1);
				if (value && value.scheme === "number") {
					add({
						raw: value.raw,
						normalized: value.normalized,
						scheme: "number",
						rank: value.rank,
						basis: "dotted-r",
						confidence: 70,
						start: index,
						end: value.end
					});
					consumed = value.end;
				}
			} else if (word === "MP") add({
				raw: "MP",
				normalized: "MP",
				scheme: "stage",
				rank: [STAGES.MP, 0],
				basis: "stage",
				confidence: 50,
				start: index,
				end: run.end
			});
			else if (/^(?:EVT|DVT|PVT|FVT)[0-9]{0,2}$/.test(word)) {
				const stage = word.slice(0, 3), number = word.slice(3);
				let end = run.end, digits = number;
				if (digits === "") {
					const sep = foldedAt(text, run.end, length);
					if (sep === 45 || sep === 95 || sep === 32) {
						const next = runAt(text, length, run.end + 1);
						if (next.text !== "" && next.text.length <= 2 && /^[0-9]+$/.test(next.text)) {
							digits = next.text;
							end = next.end;
						}
					}
				}
				add({
					raw: text.slice(index, end),
					normalized: stage + (digits === "" ? "" : stripZeros(digits)),
					scheme: "stage",
					rank: [STAGES[stage], digits === "" ? 0 : Number(digits)],
					basis: "stage",
					confidence: 80,
					start: index,
					end
				});
				consumed = end;
			} else if (word === "VER" || word === "VERSION") {
				const at = skipSeparators(text, length, run.end);
				const value = at > run.end ? readValue(text, length, at) : null;
				if (value && value.scheme === "number") {
					add({
						raw: value.raw,
						normalized: "V" + value.normalized,
						scheme: "version",
						rank: value.rank,
						basis: "version-label",
						confidence: 70,
						start: index,
						end: value.end
					});
					consumed = value.end;
				}
			} else if (/^V[0-9]{1,3}$/.test(word)) {
				const value = readValue(text, length, index + 1);
				if (value && value.scheme === "number") {
					add({
						raw: text.slice(index, value.end),
						normalized: "V" + value.normalized,
						scheme: "version",
						rank: value.rank,
						basis: "version",
						confidence: value.rank.length > 1 ? 60 : 40,
						start: index,
						end: value.end
					});
					consumed = value.end;
				}
			} else if (BOARD_WORDS.has(word)) {
				const sep = foldedAt(text, run.end, length);
				if (sep === 45 || sep === 95 || sep === 32) {
					const next = runAt(text, length, run.end + 1);
					if (next.text.length === 1 && isLetterCode(next.text.charCodeAt(0)) && foldedAt(text, next.end, length) !== 46) {
						add({
							raw: next.text,
							normalized: next.text,
							scheme: "letter",
							rank: [base26(next.text)],
							basis: "board-word",
							confidence: 55,
							start: index,
							end: next.end
						});
						consumed = next.end;
					}
				}
			}
		}
		index = Math.max(consumed, index + 1);
	}
	for (const number of recognizeBoardNumbers(text, {
		scope: options.scope,
		meter
	})) {
		if (number.revision === void 0 || found.length >= 256) continue;
		const revision = number.revision;
		const single = /^[A-Z]+$/.test(revision) && revision.length <= 2;
		const value = single ? null : readValue(revision, revision.length, 0);
		const scheme = single ? "letter" : value?.scheme ?? "alnum";
		const rank = single ? [base26(revision)] : value?.rank ?? [0];
		found.push({
			raw: revision,
			normalized: single ? revision : value?.normalized ?? revision,
			scheme,
			rank,
			basis: "board-number",
			confidence: Math.min(80, number.confidence),
			start: number.start,
			end: number.end
		});
	}
	found.sort((a, b) => a.start - b.start || a.end - b.end);
	return found;
}
/** The most confident revision (then the first), or undefined. */
function bestRevision(matches) {
	let best;
	for (const match of matches) if (!best || match.confidence > best.confidence) best = match;
	return best;
}
/**
* Orders two revisions: negative when `a` is older, positive when newer, 0 when equal. Returns undefined when the revisions
* are in different schemes, because their order cannot be known from the text (the caller shows "order unknown" and may use
* the file's modification time as a labelled hint).
*/
function compareRevisions(a, b) {
	if (a.scheme !== b.scheme) return void 0;
	const size = Math.max(a.rank.length, b.rank.length);
	for (let index = 0; index < size; index++) {
		const left = a.rank[index] ?? 0, right = b.rank[index] ?? 0;
		if (left !== right) return left < right ? -1 : 1;
	}
	return 0;
}
var ARCHIVE_EXTENSIONS = /* @__PURE__ */ new Set([
	"zip",
	"rar",
	"7z",
	"tar",
	"gz",
	"tgz"
]);
/** Reads one name (a file name without its extension, a folder name or an archive name). */
function analyzeName(text, source, extension, options = {}) {
	const scope = source;
	const meter = options.meter;
	const wrap = (items) => items.map((value) => ({
		value,
		source,
		segment: 0
	}));
	const documents = documentTypeHints(text, {
		extension: extension ?? "",
		meter
	});
	return {
		boardNumbers: wrap(recognizeBoardNumbers(text, {
			scope,
			meter
		})),
		revisions: wrap(parseRevisions(text, {
			scope,
			meter
		})),
		vendors: wrap(vendorHints(text, { meter })),
		devices: wrap(deviceTypeHints(text, { meter })),
		documents: wrap(documents),
		documentsFromExtension: documents.filter((hint) => hint.basis === "extension" || hint.basis === "weak-extension")
	};
}
/** Splits a path at "/" and "\\" and drops empty and "." segments. */
function pathSegments(path) {
	if (typeof path !== "string") return [];
	const text = path.length > 1e5 ? path.slice(path.length - MAX_TEXT_LENGTH) : path;
	const out = [];
	let start = 0;
	for (let index = 0; index <= text.length; index++) {
		const code = index < text.length ? text.charCodeAt(index) : 47;
		if (code === 47 || code === 92) {
			const part = text.slice(start, index);
			if (part !== "" && part !== "." && part !== "..") out.push(part);
			start = index + 1;
		}
	}
	return out.length > 12 ? out.slice(out.length - 12) : out;
}
/** Reads a relative path (folders, optional archive name, file name). Never opens anything. */
function analyzePath(path, options = {}) {
	const segments = pathSegments(path);
	const result = {
		boardNumbers: [],
		revisions: [],
		vendors: [],
		devices: [],
		documents: [],
		best: { documents: [] },
		extension: ""
	};
	segments.forEach((segment, index) => {
		const last = index === segments.length - 1;
		const extension = extensionOf(segment);
		const isArchive = !last ? ARCHIVE_EXTENSIONS.has(extension) : false;
		const source = last ? "name" : isArchive ? "archive" : "folder";
		const text = (last || isArchive) && extension !== "" ? segment.slice(0, segment.length - extension.length - 1) : segment;
		if (last) result.extension = extension;
		const analysis = analyzeName(text, source, last ? extension : "", options);
		for (const key of [
			"boardNumbers",
			"revisions",
			"vendors",
			"devices",
			"documents"
		]) result[key].push(...analysis[key].map((item) => ({
			...item,
			segment: index
		})));
	});
	const pick = (items) => {
		let best;
		for (const item of items) if (!best || item.value.confidence > best.value.confidence || item.value.confidence === best.value.confidence && item.segment >= best.segment) best = item;
		return best?.value;
	};
	result.best.boardNumber = pick(result.boardNumbers);
	result.best.revision = pick(result.revisions);
	result.best.vendor = summarizeHints(result.vendors.map((item) => item.value))[0];
	result.best.device = summarizeHints(result.devices.map((item) => item.value))[0];
	result.best.documents = summarizeHints(result.documents.map((item) => item.value));
	return result;
}
//#endregion
//#region src/lib/library/devices/identity.ts
/**
* Identity facts of one file, read from its relative path only (folders, file name, extension). Nothing is opened.
*
* Board codes and revisions come from the knowledge layer (analyzePath) and from a label-prefixed code rule ("MB-Q731"). Each fact
* keeps the segment and source it came from, so every later decision can explain itself. Folder and file-name tokens are one
* correlated name source family: the same word in both is not two independent pieces of evidence.
*
* The file role says what kind of file this is. Binary firmware extensions (.bin .rom .fd .cap .hex) only ever yield a candidate
* role; they are never called a BIOS. The role can be overridden by a user correction.
*/
var FIRMWARE_EXTENSIONS = /* @__PURE__ */ new Set([
	"bin",
	"rom",
	"fd",
	"cap",
	"hex"
]);
/** Words that say nothing about a board on their own. They never become aliases and never confirm anything. */
var GENERIC_WORDS = /* @__PURE__ */ new Set([
	"board",
	"boards",
	"main",
	"mainboard",
	"bios",
	"rev",
	"revision",
	"backup",
	"laptop",
	"schematic",
	"boardview",
	"file",
	"copy",
	"final",
	"new",
	"old",
	"misc",
	"repair",
	"pdf",
	"bin",
	"rom",
	"fd",
	"cap",
	"hex",
	"folder",
	"download",
	"downloads",
	"data",
	"tmp",
	"the",
	"and",
	"for",
	"version",
	"ver",
	"fw",
	"firmware",
	"desktop",
	"phone",
	"tablet",
	"device",
	"logic",
	"pcb",
	"update",
	"test",
	"bak",
	"set",
	"part",
	"parts",
	"unknown",
	"other",
	"docs",
	"doc",
	"manual",
	"service",
	"image",
	"photo",
	"dump",
	"read",
	"archive",
	"assembly",
	"bill",
	"bom",
	"brd",
	"circuit",
	"cobblestay",
	"customers",
	"datasheets",
	"diagram",
	"document",
	"drive",
	"dsc",
	"dunlin",
	"edge",
	"evt",
	"files",
	"gannet",
	"img",
	"kapcsolasi",
	"layout",
	"list",
	"lists",
	"maintenance",
	"manuals",
	"marshwick",
	"materials",
	"mini",
	"oakhollow",
	"photos",
	"pvt",
	"pxl",
	"rajz",
	"ruff",
	"schema",
	"schematics",
	"sch",
	"shearwater",
	"sort",
	"stuff",
	"viewer",
	"whimbrel",
	"work"
]);
var REVISION_TOKEN = /^(rev|r|v|ver)\d*$/;
var LABELLED_CODE = /(?<![A-Za-z0-9])(MB|PCB|BD|LB)[-_ ]?([A-Z]{0,3}\d{2,5}[A-Z]?)(?![A-Za-z0-9])/gi;
var MAX_ALIASES = 16;
var MIN_BOARD_NUMBER_CONFIDENCE = 50;
var LABELLED_CODE_CONFIDENCE = 55;
var DOCUMENT_ROLE = {
	board: "boardview",
	schematic: "schematic",
	"board-pdf": "board-pdf"
};
function tokensOf(text) {
	return searchKey(text).split(" ").filter((token) => token !== "");
}
/** Reads the identity of a file from its canonical relative path. Total, linear in the path length. */
function extractIdentity(path, options) {
	const segments = path.split("/").filter((part) => part !== "");
	const name = segments[segments.length - 1] ?? "";
	const folders = segments.slice(0, -1);
	const extension = extensionOf$1(name);
	const stem = extension === "" ? name : name.slice(0, name.length - extension.length - 1);
	const analysis = analyzePath(canonicalPath(segments));
	const evidence = [];
	let boardCode;
	let boardCodeConfidence = 0;
	const nameCodes = codesInFileName(analysis, stem, segments.length - 1);
	const ambiguousCodes = nameCodes.length >= 2 ? nameCodes : void 0;
	const bn = analysis.best.boardNumber;
	if (ambiguousCodes !== void 0) evidence.push({
		field: "board-code",
		value: ambiguousCodes.join(", "),
		source: "name",
		segment: segments.length - 1,
		confidence: 0
	});
	else if (bn !== void 0 && bn.confidence >= MIN_BOARD_NUMBER_CONFIDENCE) {
		boardCode = bn.normalized;
		boardCodeConfidence = bn.confidence;
		evidence.push({
			field: "board-code",
			value: bn.normalized,
			source: bn.scope === "folder" ? "folder" : "name",
			segment: segmentIndexOf(analysis, bn.normalized, segments),
			confidence: bn.confidence
		});
	} else {
		const labelled = findLabelledCode(stem, folders);
		if (labelled !== void 0) {
			boardCode = labelled.value;
			boardCodeConfidence = LABELLED_CODE_CONFIDENCE;
			evidence.push({
				field: "board-code",
				value: labelled.value,
				source: "label",
				segment: labelled.segment,
				confidence: LABELLED_CODE_CONFIDENCE
			});
		}
	}
	let revision;
	const rv = analysis.best.revision;
	if (rv !== void 0) {
		revision = {
			normalized: rv.normalized,
			scheme: rv.scheme,
			rank: [...rv.rank]
		};
		evidence.push({
			field: "revision",
			value: rv.normalized,
			source: "name",
			segment: segments.length - 1,
			confidence: rv.confidence
		});
	} else {
		const fallback = fallbackRevision(stem, folders);
		if (fallback !== void 0) {
			revision = fallback.revision;
			evidence.push({
				field: "revision",
				value: fallback.revision.normalized,
				source: "token",
				segment: fallback.segment,
				confidence: FALLBACK_REVISION_CONFIDENCE
			});
		}
	}
	const vendor = analysis.best.vendor?.id;
	const device = analysis.best.device?.id;
	if (vendor !== void 0) evidence.push({
		field: "vendor",
		value: vendor,
		source: "name",
		segment: segments.length - 1,
		confidence: analysis.best.vendor?.confidence ?? 0
	});
	if (device !== void 0) evidence.push({
		field: "device",
		value: device,
		source: "name",
		segment: segments.length - 1,
		confidence: analysis.best.device?.confidence ?? 0
	});
	const { role, roleBasis } = roleOf(stem, extension, analysis);
	const finalRole = options.roleOverride ?? role;
	evidence.push({
		field: "role",
		value: finalRole,
		source: options.roleOverride !== void 0 ? "correction" : roleBasisSource(roleBasis),
		segment: segments.length - 1,
		confidence: options.roleOverride !== void 0 ? 100 : 50
	});
	const aliases = aliasesOf(stem, folders, ambiguousCodes ?? (boardCode === void 0 ? [] : [boardCode]), revision);
	for (const alias of aliases) evidence.push({
		field: "alias",
		value: alias,
		source: "token",
		segment: segments.length - 1,
		confidence: 20
	});
	return {
		path: canonicalPath(segments),
		role: finalRole,
		roleBasis: options.roleOverride !== void 0 ? "correction" : roleBasis,
		boardCode,
		boardCodeConfidence,
		ambiguousCodes,
		revision,
		vendor,
		device,
		aliases,
		evidence
	};
}
function segmentIndexOf(analysis, normalized, segments) {
	const hit = analysis.boardNumbers.find((item) => item.value.normalized === normalized);
	if (hit === void 0) return segments.length - 1;
	return hit.segment;
}
var FALLBACK_REVISION = /^r(?:ev)?(\d{1,2})$/;
var FALLBACK_REVISION_CONFIDENCE = 45;
/** A standalone "r2", "rev02" or "R1" token: name first, then folders from the nearest. Numeric scheme, like the knowledge layer. */
function fallbackRevision(stem, folders) {
	const scan = (text) => {
		for (const token of tokensOf(text)) {
			const match = FALLBACK_REVISION.exec(token);
			if (match !== null) return Number(match[1]);
		}
	};
	const make = (value, segment) => ({
		revision: {
			normalized: String(value),
			scheme: "number",
			rank: [value]
		},
		segment
	});
	const inName = scan(stem);
	if (inName !== void 0) return make(inName, folders.length);
	for (let index = folders.length - 1; index >= 0; index--) {
		const inFolder = scan(folders[index]);
		if (inFolder !== void 0) return make(inFolder, index);
	}
}
function findLabelledCode(stem, folders) {
	const scan = (text) => {
		LABELLED_CODE.lastIndex = 0;
		const match = LABELLED_CODE.exec(text);
		if (match === null) return void 0;
		return `${match[1].toUpperCase()}-${match[2].toUpperCase()}`;
	};
	const inName = scan(stem);
	if (inName !== void 0) return {
		value: inName,
		segment: folders.length
	};
	for (let index = folders.length - 1; index >= 0; index--) {
		const inFolder = scan(folders[index]);
		if (inFolder !== void 0) return {
			value: inFolder,
			segment: index
		};
	}
}
function roleOf(stem, extension, analysis) {
	const nameTokens = new Set(tokensOf(stem));
	if (FIRMWARE_EXTENSIONS.has(extension)) {
		if (nameTokens.has("ec") || nameTokens.has("embedded controller")) return {
			role: "ec-firmware",
			roleBasis: "token"
		};
		if (nameTokens.has("me") || nameTokens.has("ish") || nameTokens.has("management engine")) return {
			role: "me-firmware",
			roleBasis: "token"
		};
		if (nameTokens.has("dump") || nameTokens.has("readout") || nameTokens.has("mentett")) return {
			role: "saved-dump",
			roleBasis: "token"
		};
		return {
			role: "bios-candidate",
			roleBasis: "extension"
		};
	}
	const first = analysis.best.documents[0];
	if (first !== void 0 && DOCUMENT_ROLE[first.id] !== void 0) return {
		role: DOCUMENT_ROLE[first.id],
		roleBasis: "analysis"
	};
	if (first !== void 0) return {
		role: "document",
		roleBasis: "analysis"
	};
	return {
		role: "other",
		roleBasis: "analysis"
	};
}
function roleBasisSource(basis) {
	if (basis === "extension") return "extension";
	if (basis === "token") return "token";
	return "name";
}
/**
* Every distinct board code named in the file name (its last segment, not the folders), sorted. Two or more mean an ambiguous name.
* A code counts when the knowledge layer reads it with confidence, or when it has the label form ("MB-Q731").
*/
function codesInFileName(analysis, stem, nameIndex) {
	const codes = /* @__PURE__ */ new Set();
	for (const item of analysis.boardNumbers) if (item.segment === nameIndex && item.value.confidence >= MIN_BOARD_NUMBER_CONFIDENCE) codes.add(item.value.normalized);
	LABELLED_CODE.lastIndex = 0;
	for (const match of stem.matchAll(LABELLED_CODE)) codes.add(`${match[1].toUpperCase()}-${match[2].toUpperCase()}`);
	LABELLED_CODE.lastIndex = 0;
	return [...codes].sort();
}
function aliasesOf(stem, folders, codes, revision) {
	const codeTokens = new Set(codes.flatMap((code) => tokensOf(code)));
	const out = /* @__PURE__ */ new Set();
	for (const text of [stem, ...folders]) for (const token of tokensOf(text)) {
		if (out.size >= MAX_ALIASES) break;
		if (token.length < 3 || !/\p{L}/u.test(token)) continue;
		if (GENERIC_WORDS.has(token) || REVISION_TOKEN.test(token) || codeTokens.has(token)) continue;
		if (revision !== void 0 && token === revision.normalized.toLowerCase()) continue;
		out.add(token);
	}
	return [...out].sort();
}
/** Compares two revisions of the same scheme. undefined when either is missing or the schemes differ (no verdict). */
function revisionsDiffer(a, b) {
	if (a === void 0 || b === void 0) return void 0;
	if (a.scheme !== b.scheme) return void 0;
	const order = compareRevisions({
		scheme: a.scheme,
		rank: a.rank
	}, {
		scheme: b.scheme,
		rank: b.rank
	});
	if (order === void 0) return void 0;
	return order !== 0;
}
//#endregion
//#region src/lib/library/devices/match.ts
/**
* Association of files (boardview, schematic, board PDF, BIOS candidate) with motherboard groups.
*
* Decision rules, in order:
*  1. An explicit conflict vetoes automatic confirmation: two different board codes (even one character apart), or two revisions
*     of the same scheme that differ. A conflict is shown with both values and yields state "review", also for a user link.
*  2. A durable user link is "confirmed" when no conflict exists.
*  3. A strong, unique content identity of the file (parser/L6 evidence) that equals the board code confirms the link.
*  4. Name evidence only (board code in a file or folder name) gives "probable". A shared alias, a shared revision or a shared
*     brand/device word never confirms, and alias-only evidence gives "review".
*  4a. A file name that names two or more different codes ("MB-Q731 vs MB-Q732") is ambiguous: each named code is a "review"
*     candidate with basis "ambiguous", and none is confirmed or probable by name. Only a user link settles it (rule 2).
*  5. Without any usable evidence no association is produced.
*
* Every association lists its signals with weights and its conflicts, so the reason is always visible. Scores are explanation
* numbers, not calibrated probabilities.
*
* Cost: the index structures are by board code, by alias and by user link (one map from file path to its linked anchors, built
* once). Each file is looked up in the indexes only, so the work is linear in files plus links plus judged candidates. Candidates
* from a shared alias can still be many; that is inherent to the output, which lists every alias-only review pair.
*/
var WEIGHT = {
	codeName: 40,
	codeContent: 60,
	revisionAgree: 15,
	aliasEach: 8,
	aliasMax: 24
};
function pairKey(filePath, anchorId) {
	return `${filePath}\u0000${anchorId}`;
}
function normalizeCode(code) {
	return code.toUpperCase();
}
/** Matches every file against the anchors. Deterministic: output is sorted by file path, then anchor id. */
function matchFiles(anchors, files, decisions = {}, counters) {
	const byCode = /* @__PURE__ */ new Map();
	const byAlias = /* @__PURE__ */ new Map();
	for (const anchor of anchors) {
		if (anchor.boardCode !== void 0) {
			const key = normalizeCode(anchor.boardCode);
			const list = byCode.get(key) ?? [];
			list.push(anchor);
			byCode.set(key, list);
		}
		for (const alias of anchor.aliases) {
			const list = byAlias.get(alias) ?? [];
			list.push(anchor);
			byAlias.set(alias, list);
		}
	}
	const anchorById = /* @__PURE__ */ new Map();
	for (const anchor of anchors) anchorById.set(anchor.id, anchor);
	const linkedByFile = /* @__PURE__ */ new Map();
	if (decisions.userLinks !== void 0) for (const key of decisions.userLinks) {
		if (counters !== void 0) counters.linkSteps++;
		for (let at = key.indexOf("\0"); at >= 0; at = key.indexOf("\0", at + 1)) {
			const anchorId = key.slice(at + 1);
			if (!anchorById.has(anchorId)) continue;
			const filePath = key.slice(0, at);
			const list = linkedByFile.get(filePath);
			if (list === void 0) linkedByFile.set(filePath, [anchorId]);
			else list.push(anchorId);
		}
	}
	const out = [];
	for (const file of files) {
		const identity = file.identity;
		const fileCode = file.contentCode?.unique === true ? file.contentCode.code : identity.boardCode;
		const candidates = /* @__PURE__ */ new Map();
		if (identity.boardCode !== void 0) for (const anchor of byCode.get(normalizeCode(identity.boardCode)) ?? []) candidates.set(anchor.id, anchor);
		if (identity.ambiguousCodes !== void 0) for (const code of identity.ambiguousCodes) for (const anchor of byCode.get(normalizeCode(code)) ?? []) candidates.set(anchor.id, anchor);
		if (file.contentCode !== void 0) for (const anchor of byCode.get(normalizeCode(file.contentCode.code)) ?? []) candidates.set(anchor.id, anchor);
		for (const alias of identity.aliases) for (const anchor of byAlias.get(alias) ?? []) candidates.set(anchor.id, anchor);
		const linked = linkedByFile.get(file.path);
		if (counters !== void 0) counters.linkSteps++;
		if (linked !== void 0) for (const anchorId of linked) candidates.set(anchorId, anchorById.get(anchorId));
		if (counters !== void 0) {
			counters.files++;
			counters.candidates += candidates.size;
		}
		for (const anchor of candidates.values()) {
			const key = pairKey(file.path, anchor.id);
			if (decisions.detached?.has(key) === true) continue;
			if (counters !== void 0) counters.judgments++;
			const association = judge(file, fileCode, anchor, decisions.userLinks?.has(key) === true);
			if (association !== void 0) out.push(association);
		}
	}
	out.sort((a, b) => a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : a.anchorId < b.anchorId ? -1 : a.anchorId > b.anchorId ? 1 : 0);
	return out;
}
function judge(file, fileCode, anchor, userLinked) {
	const identity = file.identity;
	const signals = [];
	const conflicts = [];
	const missing = [];
	if (fileCode !== void 0 && anchor.boardCode !== void 0 && normalizeCode(fileCode) !== normalizeCode(anchor.boardCode)) conflicts.push({
		field: "board-code",
		fileValue: fileCode,
		anchorValue: anchor.boardCode
	});
	const contentMatches = file.contentCode?.unique === true && anchor.boardCode !== void 0 && normalizeCode(file.contentCode.code) === normalizeCode(anchor.boardCode);
	const nameMatches = !contentMatches && identity.boardCode !== void 0 && anchor.boardCode !== void 0 && normalizeCode(identity.boardCode) === normalizeCode(anchor.boardCode);
	if (identity.boardCode !== void 0 && file.contentCode !== void 0 && file.contentCode.unique && normalizeCode(identity.boardCode) !== normalizeCode(file.contentCode.code)) conflicts.push({
		field: "board-code",
		fileValue: identity.boardCode,
		anchorValue: file.contentCode.code
	});
	const ambiguousNames = identity.ambiguousCodes;
	const ambiguousHit = !contentMatches && ambiguousNames !== void 0 && anchor.boardCode !== void 0 && ambiguousNames.includes(normalizeCode(anchor.boardCode));
	if (ambiguousHit) signals.push({
		signal: "code-ambiguous",
		weight: 0,
		detail: `names ${ambiguousNames.join(", ")}`
	});
	const revisionDiff = revisionsDiffer(identity.revision, anchor.revision);
	if (revisionDiff === true) conflicts.push({
		field: "revision",
		fileValue: identity.revision?.normalized ?? "",
		anchorValue: anchor.revision?.normalized ?? ""
	});
	else if (revisionDiff === false) signals.push({
		signal: "revision-agree",
		weight: WEIGHT.revisionAgree,
		detail: `revision ${identity.revision?.normalized ?? ""}`
	});
	const shared = identity.aliases.filter((alias) => anchor.aliases.includes(alias));
	if (shared.length > 0) {
		const weight = Math.min(WEIGHT.aliasMax, shared.length * WEIGHT.aliasEach);
		signals.push({
			signal: "alias",
			weight,
			detail: shared.slice(0, 3).join(", ")
		});
	}
	if (contentMatches) signals.push({
		signal: "code-content",
		weight: WEIGHT.codeContent,
		detail: `content ${file.contentCode?.code ?? ""}`
	});
	else if (nameMatches) signals.push({
		signal: "code-name",
		weight: WEIGHT.codeName,
		detail: `name ${identity.boardCode ?? ""}`
	});
	if (file.contentCode === void 0) missing.push("content-identity");
	if (identity.revision === void 0) missing.push("file-revision");
	if (identity.boardCode === void 0) missing.push("file-board-code");
	const score = Math.min(100, signals.reduce((sum, signal) => sum + signal.weight, 0));
	const hasCodeEvidence = contentMatches || nameMatches;
	const hasAlias = shared.length > 0;
	let state;
	let basis;
	if (conflicts.length > 0) {
		if (!hasCodeEvidence && !userLinked && !hasAlias) return void 0;
		state = "review";
		basis = "conflict";
	} else if (userLinked) {
		state = "confirmed";
		basis = "user";
	} else if (contentMatches) {
		state = "confirmed";
		basis = "content";
	} else if (nameMatches) {
		state = "probable";
		basis = "names";
	} else if (ambiguousHit) {
		state = "review";
		basis = "ambiguous";
	} else if (hasAlias) {
		state = "review";
		basis = "alias";
	} else return;
	return {
		anchorId: anchor.id,
		filePath: file.path,
		role: identity.role,
		state,
		basis,
		score,
		signals,
		conflicts,
		missing
	};
}
var library_limits_default = {
	maxRelativePathUnits: 32767,
	maxIdentifierUnits: 512
};
//#endregion
//#region src/lib/library/devices/corrections.ts
/**
* User corrections of the device catalogue, kept as a durable JSON document in the user's local data folder (the caller passes the
* text; this module never touches the disk and never touches a scanned file).
*
* A correction targets a file by (root id, identity key of its root-relative path) and a motherboard group by its id. Targets are
* not generation ids, so a correction survives rescans and index rebuilds. A correction whose file is not in the current scan is
* reported as a missing target and is never silently moved to another file.
*
* Document shape: { "version": 1, "platform": "win32"|"darwin"|"linux", "corrections": [ ... ] }. Unknown or invalid entries are
* dropped and counted; the rest is kept. Later entries for the same target override earlier ones.
*/
var CORRECTIONS_VERSION = 1;
var MAX_CORRECTIONS = 5e4;
/** Limit for ids, aliases and revisions (UTF-16 units). Shared with the main process through shared/library-limits.json. */
var MAX_TEXT = library_limits_default.maxIdentifierUnits;
/**
* Limit for a root-relative path (UTF-16 units), one value for every Library layer (shared/library-limits.json, TB-068). It is the Windows
* extended-length limit (32767) applied to the relative part only: the codec does not know the root's absolute prefix, so a full path that
* is near the limit is refused by the scanner when it opens the file, not here. The legacy 260-character MAX_PATH is not a limit for the
* Library. A longer path is refused with an explicit reason ('path-too-long'), never truncated, and the knowledge layer never cuts a segment.
*/
var MAX_PATH_TEXT = library_limits_default.maxRelativePathUnits;
/**
* The catalogue's own file roles. Stored corrections use these names (format version 1, see "Stored names" below). The canonical
* Library roles are in CANONICAL_ROLE_OF.
*/
var FILE_ROLES = [
	"boardview",
	"schematic",
	"board-pdf",
	"document",
	"bios-candidate",
	"ec-firmware",
	"me-firmware",
	"saved-dump",
	"other"
];
/**
* Explicit mapping from each catalogue file role to the canonical Library role (model.ts FILE_ROLES). Every catalogue role has its own
* entry; nothing is guessed. Decisions:
* - 'document' maps to 'unknown' (manual classification). The catalogue uses one generic document role, but the canonical schema
*   separates 'datasheet' from 'service-manual'. Choosing either one would invent a classification the file does not have. A stored
*   'document' correction is an explicit manual classification; the user or the root confirms the canonical role before it is used.
* - The canonical roles 'datasheet', 'service-manual', 'bom', 'photo' and 'thermal' are not produced by any catalogue role yet.
*
* Stored names: the document keeps the catalogue names (version 1). Migration to canonical names is not part of this change; the
* plan is in the report (version 2 would store canonical names, and version 1 names would stay readable through this table).
*/
var CANONICAL_ROLE_OF = {
	boardview: "board",
	schematic: "schematic",
	"board-pdf": "board-pdf",
	document: "unknown",
	"bios-candidate": "firmware",
	"ec-firmware": "firmware",
	"me-firmware": "firmware",
	"saved-dump": "firmware",
	other: "other"
};
var BOARD_CODE = /^[A-Z0-9][A-Z0-9-]{1,31}$/;
/** Windows device names, refused on every platform (with or without an extension; the check is case-insensitive). */
var WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/i;
/** Characters Windows does not allow in a file name, plus the separators and control characters. Refused on every platform. */
var FORBIDDEN_CHARACTER = /[<>:"|?*\\\x00-\x1f]/;
function isValidSegment(part) {
	if (part === "" || part === "." || part === "..") return false;
	if (part.endsWith(".") || part.endsWith(" ")) return false;
	return !WINDOWS_RESERVED_NAME.test(part.split(".")[0]);
}
/**
* True when `path` is a root-relative path with forward slashes only, and it is a valid name on Windows, macOS and Linux alike. Refused:
* a leading slash (absolute or UNC), any forbidden character (colon, backslash, <>"|?*, control characters), an empty, '.' or '..'
* segment, a segment ending in a dot or a space, and a Windows device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9) as the base name of
* any segment, with or without an extension. The verdict does not depend on the platform of the document. The length is checked separately.
*/
function isValidRelativeTarget(path) {
	if (path.startsWith("/") || FORBIDDEN_CHARACTER.test(path)) return false;
	return path.split("/").every(isValidSegment);
}
/** The file reference used by matching: root id and identity key, joined. Stable across rescans of the same root. */
function fileRefOf(target, platform) {
	return `${target.rootId}\u0000${identityKey(target.path.split("/").filter((part) => part !== ""), platform)}`;
}
function text(value, max = MAX_TEXT) {
	return typeof value === "string" && value.length > 0 && value.length <= max ? value : void 0;
}
function target(value) {
	if (typeof value !== "object" || value === null) return "invalid-entry";
	const rootId = text(value.rootId);
	const rawPath = value.path;
	if (typeof rawPath === "string" && rawPath.length > MAX_PATH_TEXT) return "path-too-long";
	const path = text(rawPath, MAX_PATH_TEXT);
	if (rootId === void 0 || path === void 0) return "invalid-entry";
	return isValidRelativeTarget(path) ? {
		rootId,
		path
	} : "invalid-relative-path";
}
function validateCorrection(value) {
	if (typeof value !== "object" || value === null) return "invalid-entry";
	const v = value;
	switch (v.op) {
		case "link":
		case "unlink": {
			const file = target(v.file);
			const anchorId = text(v.anchorId);
			if (typeof file === "string") return file;
			return anchorId !== void 0 ? {
				op: v.op,
				file,
				anchorId
			} : "invalid-entry";
		}
		case "role": {
			const file = target(v.file);
			if (typeof file === "string") return file;
			if (v.role === null) return {
				op: "role",
				file,
				role: null
			};
			if (typeof v.role !== "string") return "invalid-entry";
			return FILE_ROLES.includes(v.role) ? {
				op: "role",
				file,
				role: v.role
			} : "unknown-role";
		}
		case "alias": {
			const anchorId = text(v.anchorId);
			const alias = typeof v.alias === "string" ? searchKey(v.alias) : "";
			if (anchorId === void 0 || alias.length < 2 || alias.length > 64 || typeof v.remove !== "boolean") return "invalid-entry";
			return {
				op: "alias",
				anchorId,
				alias,
				remove: v.remove
			};
		}
		case "board-code": {
			const anchorId = text(v.anchorId);
			if (anchorId === void 0) return "invalid-entry";
			if (v.code === null) return {
				op: "board-code",
				anchorId,
				code: null
			};
			const code = typeof v.code === "string" ? v.code.toUpperCase() : "";
			return BOARD_CODE.test(code) ? {
				op: "board-code",
				anchorId,
				code
			} : "invalid-entry";
		}
		case "revision": {
			const anchorId = text(v.anchorId);
			if (anchorId === void 0) return "invalid-entry";
			if (v.revision === null) return {
				op: "revision",
				anchorId,
				revision: null
			};
			const revision = text(v.revision);
			return revision !== void 0 && bestRevision(parseRevisions(revision)) !== void 0 ? {
				op: "revision",
				anchorId,
				revision
			} : "invalid-entry";
		}
		default: return "invalid-entry";
	}
}
/** Parses the stored document. Invalid input yields an empty document plus an error; refused entries are counted in `dropped` and listed with a reason in `rejections`. */
function parseCorrections(source) {
	const empty = (error) => ({
		document: {
			version: 1,
			platform: "linux",
			corrections: []
		},
		dropped: 0,
		rejections: [],
		error
	});
	let raw;
	try {
		raw = JSON.parse(source);
	} catch {
		return empty("not-json");
	}
	if (typeof raw !== "object" || raw === null || raw.version !== 1) return empty("wrong-version");
	const platform = raw.platform;
	if (platform !== "win32" && platform !== "darwin" && platform !== "linux") return empty("bad-platform");
	const list = Array.isArray(raw.corrections) ? raw.corrections : [];
	const corrections = [];
	const rejections = [];
	list.slice(0, MAX_CORRECTIONS).forEach((item, index) => {
		const checked = validateCorrection(item);
		if (typeof checked === "string") rejections.push({
			index,
			reason: checked
		});
		else corrections.push(checked);
	});
	for (let index = MAX_CORRECTIONS; index < list.length; index++) rejections.push({
		index,
		reason: "too-many"
	});
	return {
		document: {
			version: 1,
			platform,
			corrections
		},
		dropped: rejections.length,
		rejections
	};
}
/** The stored text of a document. Deterministic: the same corrections give the same bytes. */
function serializeCorrections(document) {
	return `${JSON.stringify({
		version: 1,
		platform: document.platform,
		corrections: document.corrections.slice(0, MAX_CORRECTIONS)
	}, null, 2)}\n`;
}
/** The key a correction overrides earlier ones with: one per file role, file link, file/anchor pair, anchor field or alias. */
function supersedeKey(correction, platform) {
	switch (correction.op) {
		case "link":
		case "unlink": return `pair|${fileRefOf(correction.file, platform)}|${correction.anchorId}`;
		case "role": return `role|${fileRefOf(correction.file, platform)}`;
		case "alias": return `alias|${correction.anchorId}|${correction.alias}`;
		case "board-code": return `board-code|${correction.anchorId}`;
		case "revision": return `revision|${correction.anchorId}`;
	}
}
/** Keeps the last correction for each target, in order of appearance. */
function compactCorrections(corrections, platform) {
	const last = /* @__PURE__ */ new Map();
	for (const correction of corrections) {
		const key = supersedeKey(correction, platform);
		last.delete(key);
		last.set(key, correction);
	}
	return [...last.values()];
}
/**
* Turns the compacted corrections into matcher input. `presentFileRefs` is the set of file references of the current scan
* (complete or not). A file-targeted correction whose file is absent is listed in `missingTargets` and has no effect.
*/
function applyCorrections(corrections, platform, presentFileRefs) {
	const userLinks = /* @__PURE__ */ new Set();
	const detached = /* @__PURE__ */ new Set();
	const roleOverrides = /* @__PURE__ */ new Map();
	const anchorPatches = /* @__PURE__ */ new Map();
	const missingTargets = [];
	const patchOf = (anchorId) => {
		const existing = anchorPatches.get(anchorId);
		if (existing !== void 0) return existing;
		const created = {
			aliasAdd: [],
			aliasRemove: []
		};
		anchorPatches.set(anchorId, created);
		return created;
	};
	for (const correction of compactCorrections(corrections, platform)) {
		if (correction.op === "alias") {
			const patch = patchOf(correction.anchorId);
			if (correction.remove) patch.aliasRemove.push(correction.alias);
			else patch.aliasAdd.push(correction.alias);
			continue;
		}
		if (correction.op === "board-code") {
			patchOf(correction.anchorId).boardCode = correction.code;
			continue;
		}
		if (correction.op === "revision") {
			patchOf(correction.anchorId).revision = correction.revision;
			continue;
		}
		const ref = fileRefOf(correction.file, platform);
		if (!presentFileRefs.has(ref)) {
			missingTargets.push(correction);
			continue;
		}
		if (correction.op === "link") userLinks.add(pairKey(ref, correction.anchorId));
		else if (correction.op === "unlink") detached.add(pairKey(ref, correction.anchorId));
		else roleOverrides.set(ref, correction.role);
	}
	return {
		decisions: {
			userLinks,
			detached
		},
		roleOverrides,
		anchorPatches,
		missingTargets
	};
}
/** Applies anchor patches (board code, revision, aliases) to a copy of the anchors. Input anchors are not changed. */
function patchAnchors(anchors, patches) {
	return anchors.map((anchor) => {
		const patch = patches.get(anchor.id);
		if (patch === void 0) return anchor;
		const aliases = new Set(anchor.aliases);
		for (const alias of patch.aliasAdd) aliases.add(alias);
		for (const alias of patch.aliasRemove) aliases.delete(alias);
		const boardCode = patch.boardCode === void 0 ? anchor.boardCode : patch.boardCode ?? void 0;
		let revision = anchor.revision;
		if (patch.revision !== void 0) {
			const best = patch.revision === null ? void 0 : bestRevision(parseRevisions(patch.revision));
			revision = best === void 0 ? void 0 : {
				normalized: best.normalized,
				scheme: best.scheme,
				rank: [...best.rank]
			};
		}
		return {
			id: anchor.id,
			boardCode,
			revision,
			aliases: [...aliases].sort()
		};
	});
}
//#endregion
//#region src/lib/library/devices/anchor-source.ts
/** One anchor per distinct (board code, revision) of the boardview files. The id is a pure function of those two values. */
function deriveBoardAnchors(files) {
	const byId = /* @__PURE__ */ new Map();
	for (const file of files) {
		const code = file.identity.boardCode;
		if (file.identity.role !== "boardview" || file.collision === true || code === void 0) continue;
		const revision = file.identity.revision;
		const id = `board:${code.toUpperCase()}|${revision?.normalized ?? ""}`;
		if (!byId.has(id)) byId.set(id, {
			id,
			boardCode: code,
			revision,
			aliases: []
		});
	}
	return [...byId.values()];
}
/**
* The default source: file-name anchors. `describe` answers from the anchors of the most recent `anchorsFor` call, so a boardId
* resolved by a scan keeps its code and revision until the next scan replaces them.
*/
function createFileNameAnchorSource() {
	const known = /* @__PURE__ */ new Map();
	return {
		async anchorsFor(scan) {
			known.clear();
			for (const anchor of scan.derived) known.set(anchor.id, {
				boardCode: anchor.boardCode,
				revision: anchor.revision?.normalized
			});
			return scan.derived;
		},
		async describe(anchorId) {
			return known.get(anchorId);
		}
	};
}
//#endregion
//#region src/lib/library/devices/catalogue.ts
/**
* The device catalogue pipeline: folder map, name identity, BIOS candidates, matching and corrections, each step skippable.
*
* Read-only by construction: the only file-system access is `DirectoryPort.readDir`. Nothing is copied, renamed, moved, deleted
* or opened; the output is an index view that the caller stores in the Library database.
*/
var STEP_NAMES = [
	"folderMap",
	"nameIdentity",
	"biosCandidates",
	"matching",
	"corrections"
];
var ALL_STEPS = {
	folderMap: true,
	nameIdentity: true,
	biosCandidates: true,
	matching: true,
	corrections: true
};
/** Roles that come from firmware extensions or their name tokens. They are candidates only, never BIOS by default. */
var FIRMWARE_ROLES = /* @__PURE__ */ new Set([
	"bios-candidate",
	"ec-firmware",
	"me-firmware",
	"saved-dump"
]);
/**
* Splits the missing file targets of darwin into case-collisions and plain missing targets. A target is a case-collision when a
* present file of the same root has the same spelling key (NFC, lower case) and a different exact path. Other platforms and all
* other corrections are returned unchanged in `missing`. Linear in the files plus the corrections.
*/
function classifyMissingTargets(missing, present, platform) {
	if (platform !== "darwin" || missing.length === 0) return {
		missing: [...missing],
		needsManual: []
	};
	const index = /* @__PURE__ */ new Map();
	for (const file of present) {
		const key = `${file.rootId}\u0000${spellingKey(file.path)}`;
		const paths = index.get(key) ?? /* @__PURE__ */ new Set();
		paths.add(file.path);
		index.set(key, paths);
	}
	const rest = [];
	const needsManual = [];
	for (const correction of missing) {
		if (!("file" in correction)) {
			rest.push(correction);
			continue;
		}
		const wanted = canonicalPath(correction.file.path.split("/").filter((part) => part !== ""));
		const candidates = index.get(`${correction.file.rootId}\u0000${spellingKey(wanted)}`);
		const candidatePaths = candidates === void 0 ? [] : [...candidates].filter((path) => path !== wanted).sort();
		if (candidatePaths.length > 0) needsManual.push({
			state: "case-collision",
			correction,
			candidatePaths
		});
		else rest.push(correction);
	}
	return {
		missing: rest,
		needsManual
	};
}
function* walkFiles(folder) {
	const stack = [folder];
	while (stack.length > 0) {
		const node = stack.pop();
		yield* node.files;
		for (const child of node.folders) stack.push(child);
	}
}
/** The input anchors first; a derived anchor is added only when no input anchor has the same id. */
function mergeAnchors(input, derived) {
	const ids = new Set(input.map((anchor) => anchor.id));
	return [...input, ...derived.filter((anchor) => !ids.has(anchor.id))];
}
async function buildDeviceCatalogue(input) {
	const on = {
		...ALL_STEPS,
		...input.steps ?? {}
	};
	const steps = {
		folderMap: "skipped",
		nameIdentity: "skipped",
		biosCandidates: "skipped",
		matching: "skipped",
		corrections: "skipped"
	};
	const skippedByRequest = [];
	const skipRequested = (step) => {
		if (on[step] && input.isStepSkipped?.(step) === true) {
			on[step] = false;
			skippedByRequest.push(step);
		}
	};
	const maps = input.roots.map((root) => ({
		rootId: root.rootId,
		map: null
	}));
	const files = [];
	let excludedFirmwareCount = 0;
	let anchors = [...input.anchors];
	let associations = [];
	let missingTargets = [];
	let needsManual = [];
	const collisions = [];
	const matchCounters = {
		files: 0,
		candidates: 0,
		judgments: 0,
		linkSteps: 0
	};
	const throwIfCancelled = () => {
		if (input.signal?.aborted) throw Object.assign(/* @__PURE__ */ new Error("the scan was cancelled"), {
			name: "AbortError",
			code: CANCELLED_CODE
		});
	};
	skipRequested("folderMap");
	if (on.folderMap) {
		steps.folderMap = "ran";
		for (let index = 0; index < input.roots.length; index++) {
			const root = input.roots[index];
			throwIfCancelled();
			maps[index].map = await mapFolderTree(root.port, input.platform, root.limits ?? DEFAULT_LIMITS, {
				signal: input.signal,
				skipPaths: root.skipPaths
			});
		}
	}
	skipRequested("corrections");
	throwIfCancelled();
	on.corrections && compactCorrections(input.corrections ?? [], input.platform);
	const pending = [];
	skipRequested("nameIdentity");
	skipRequested("biosCandidates");
	if (on.folderMap && on.nameIdentity) for (const entry of maps) {
		if (entry.map === null) continue;
		for (const file of walkFiles(entry.map.root)) pending.push({
			rootId: entry.rootId,
			file,
			fileRef: fileRefOf({
				rootId: entry.rootId,
				path: file.path
			}, input.platform)
		});
	}
	const colliding = collidingKeys(pending.map((item) => ({
		key: item.fileRef,
		path: item.file.path
	})));
	const presentRefs = /* @__PURE__ */ new Set();
	for (const item of pending) if (!colliding.has(item.fileRef)) presentRefs.add(item.fileRef);
	if (colliding.size > 0) {
		const groups = /* @__PURE__ */ new Map();
		for (const item of pending) {
			if (!colliding.has(item.fileRef)) continue;
			const group = groups.get(item.fileRef) ?? {
				rootId: item.rootId,
				paths: /* @__PURE__ */ new Set()
			};
			group.paths.add(item.file.path);
			groups.set(item.fileRef, group);
		}
		for (const group of groups.values()) collisions.push({
			rootId: group.rootId,
			paths: [...group.paths].sort()
		});
		collisions.sort((a, b) => a.rootId !== b.rootId ? a.rootId < b.rootId ? -1 : 1 : a.paths[0] < b.paths[0] ? -1 : a.paths[0] > b.paths[0] ? 1 : 0);
	}
	const applied = on.corrections ? applyCorrections(input.corrections ?? [], input.platform, presentRefs) : void 0;
	if (applied !== void 0) {
		const present = pending.filter((item) => presentRefs.has(item.fileRef)).map((item) => ({
			rootId: item.rootId,
			path: item.file.path
		}));
		const split = classifyMissingTargets(applied.missingTargets, present, input.platform);
		missingTargets = split.missing;
		needsManual = split.needsManual;
		steps.corrections = "ran";
	}
	throwIfCancelled();
	if (on.folderMap && on.nameIdentity) {
		steps.nameIdentity = "ran";
		let processed = 0;
		for (const { rootId, file, fileRef } of pending) {
			if (++processed % 4096 === 0) throwIfCancelled();
			const overrideRole = applied?.roleOverrides.get(fileRef);
			const identity = extractIdentity(file.path, {
				platform: input.platform,
				roleOverride: overrideRole ?? void 0
			});
			if (!on.biosCandidates && FIRMWARE_ROLES.has(identity.role)) {
				excludedFirmwareCount++;
				continue;
			}
			const indexed = {
				fileRef,
				rootId,
				path: file.path,
				size: file.size,
				identity
			};
			if (colliding.has(fileRef)) indexed.collision = true;
			files.push(indexed);
		}
		if (on.biosCandidates) steps.biosCandidates = "ran";
	}
	throwIfCancelled();
	if (steps.nameIdentity === "ran" && (input.deriveAnchors === true || input.anchorSource !== void 0)) {
		const derived = deriveBoardAnchors(files);
		const sourced = input.anchorSource === void 0 ? derived : await input.anchorSource.anchorsFor({
			files,
			derived
		});
		anchors = mergeAnchors(input.anchors, sourced);
	}
	if (applied !== void 0) anchors = patchAnchors(anchors, applied.anchorPatches);
	skipRequested("matching");
	if (on.matching && steps.nameIdentity === "ran") {
		steps.matching = "ran";
		const records = [];
		for (const file of files) {
			if (file.collision === true) continue;
			const content = input.contentCodes?.get(file.fileRef);
			records.push(content === void 0 ? {
				path: file.fileRef,
				identity: file.identity
			} : {
				path: file.fileRef,
				identity: file.identity,
				contentCode: content
			});
		}
		associations = matchFiles(anchors, records, applied?.decisions ?? {}, matchCounters);
	}
	const stats = {
		folders: 0,
		files: 0,
		entries: 0,
		match: matchCounters
	};
	for (const entry of maps) {
		if (entry.map === null) continue;
		stats.folders += entry.map.folderCount;
		stats.files += entry.map.fileCount;
		stats.entries += entry.map.fileCount + entry.map.folderCount + entry.map.skippedCount;
	}
	const complete = Object.values(steps).every((state) => state === "ran") && maps.every((entry) => entry.map === null || entry.map.complete);
	return {
		steps,
		maps,
		files,
		associations,
		missingTargets,
		needsManual,
		excludedFirmwareCount,
		collisions,
		stats,
		anchors,
		complete,
		skippedByRequest
	};
}
//#endregion
exports.ALL_STEPS = ALL_STEPS;
exports.CANONICAL_ROLE_OF = CANONICAL_ROLE_OF;
exports.CORRECTIONS_VERSION = CORRECTIONS_VERSION;
exports.FILE_ROLES = FILE_ROLES;
exports.MAX_CORRECTIONS = MAX_CORRECTIONS;
exports.STEP_NAMES = STEP_NAMES;
exports.buildDeviceCatalogue = buildDeviceCatalogue;
exports.createFileNameAnchorSource = createFileNameAnchorSource;
exports.deriveBoardAnchors = deriveBoardAnchors;
exports.parseCorrections = parseCorrections;
exports.serializeCorrections = serializeCorrections;
