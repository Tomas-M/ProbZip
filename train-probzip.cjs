#!/usr/bin/env node
"use strict";

// ProbZip trainer, GPL-2.0. Attribution for all input data is in NOTICE.
// Run with Node.js 24+: no npm packages, external archive tools or Python needed.
// The browser codec never imports this file or downloads training data.
const fs = require("node:fs");

const path = require("node:path");

const zlib = require("node:zlib");

const crypto = require("node:crypto");

const vm = require("node:vm");

// Budget for the complete readable JavaScript, including the embedded model.
const LIMIT = 256 * 1024;

const MAX_ORDER = 5;

const RELEASED_BUDGET = 455668;

const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

// FNV-1a gives stable entity partitions; it is not a cryptographic hash.
const hash = text => {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  return value >>> 0;
};

// Source URLs for the three live datasets can change their contents over time.
// Cache hashes detect local corruption; a fresh download records the new snapshot.
// libpostal is pinned to a commit, so its archive must match the release hash.
const SOURCES = [ {
  source: "GeoNames",
  file: "cities500.zip",
  member: "cities500.txt",
  url: "https://download.geonames.org/export/dump/cities500.zip",
  license: "CC BY 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  attribution: "GeoNames geographical database, https://www.geonames.org/"
}, {
  source: "Japan Post UTF-8 postal areas",
  file: "japan-post.zip",
  member: "utf_ken_all.csv",
  url: "https://www.post.japanpost.jp/service/search/zipcode/download/utf/zip/utf_ken_all.zip",
  license: "Japan Post does not assert copyright on postal-code data; redistribution permitted",
  licenseUrl: "https://www.post.japanpost.jp/service/search/zipcode/download/utf-readme.html"
}, {
  source: "Chunghwa Post Chinese/English street names",
  file: "taiwan-streets.ods",
  member: "content.xml",
  url: "https://www.post.gov.tw/post/download/%E4%B8%AD%E8%8B%B1%E6%96%87%E8%A1%97%E8%B7%AF%E5%90%8D%E7%A8%B1%E5%B0%8D%E7%85%A7%E6%AA%94.ods",
  datasetUrl: "https://data.gov.tw/dataset/152276",
  license: "Taiwan Open Government Data License 1.0",
  licenseUrl: "https://data.gov.tw/license"
}, {
  source: "libpostal address dictionaries",
  file: "libpostal.tar.gz",
  commit: "25099c506612b34b23b1bfe286ca6321fcf06f35",
  url: "https://codeload.github.com/openvenues/libpostal/tar.gz/25099c506612b34b23b1bfe286ca6321fcf06f35",
  archiveSha256: "7586542af4db343e744f6128a997dd75bf25b3ddc54ed1af3810ea60d2880c3b",
  license: "MIT",
  licenseUrl: "https://github.com/openvenues/libpostal/blob/25099c506612b34b23b1bfe286ca6321fcf06f35/LICENSE"
} ];

// Arguments are deliberately small: data cache, refresh, download-only and output
// version. A changed probability model requires a different first-byte format tag.
function parseArguments(argv) {
  const options = {
    cache: path.join(__dirname, ".probzip-training"),
    output: path.join(__dirname, "probzip.js")
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--refresh") options.refresh = true;
    else if (arg === "--download-only") options.downloadOnly = true;
    else if (arg === "--help") options.help = true;
    else if ([ "--cache", "--output", "--tag" ].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("Missing value for " + arg);
      if (arg === "--tag") options.tag = Number(value);
      else options[arg.slice(2)] = path.resolve(value);
    } else throw new Error("Unknown argument: " + arg);
  }
  if (options.tag !== undefined && (!Number.isInteger(options.tag) || options.tag < 1 || options.tag > 255)) {
    throw new Error("--tag must be an integer from 1 to 255; 0 is reserved for raw data.");
  }
  // Tag 88 belonged to a retired experimental model. Never reuse its identity.
  if (options.tag === 88) {
    throw new Error("Format tag 88 is retired; choose an unused --tag.");
  }
  if (options.output === __filename) throw new Error("The trainer cannot overwrite itself.");
  return options;
}

// Download into memory with a size limit, timeout and HTTP status check. Only a
// complete archive replaces a cached file; interrupted downloads leave no .part.
async function downloadSource(source, options) {
  const file = path.join(options.cache, source.file);
  const receiptFile = file + ".json";
  let archive;
  if (fs.existsSync(file) && !options.refresh) {
    archive = fs.readFileSync(file);
    if (fs.existsSync(receiptFile)) {
      const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
      if (receipt.url !== source.url || receipt.archiveSha256 !== sha256(archive)) {
        throw new Error("Corrupt or mismatched cache: " + file + "; use --refresh.");
      }
    }
  } else {
    console.log("Downloading " + source.url);
    const response = await fetch(source.url, {
      signal: AbortSignal.timeout(18e4)
    });
    if (!response.ok) throw new Error(source.source + ": HTTP " + response.status);
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > 1e8) throw new Error(source.source + ": archive exceeds 100 MB");
      chunks.push(chunk);
    }
    archive = Buffer.concat(chunks);
  }
  const digest = sha256(archive);
  if (source.archiveSha256 && source.archiveSha256 !== digest) throw new Error("Pinned source hash mismatch: " + source.source);
  const text = source.member ? extract(archive, source.member) : null;
  const receipt = {
    ...source,
    archiveBytes: archive.length,
    archiveSha256: digest
  };
  if (text) Object.assign(receipt, {
    textBytes: text.length,
    textSha256: sha256(text)
  });
  fs.mkdirSync(options.cache, {
    recursive: true
  });
  // Same-directory rename prevents partially written archives being reused.
  fs.writeFileSync(file + ".part", archive);
  fs.renameSync(file + ".part", file);
  fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + "\n");
  console.log(source.source + ": " + archive.length + " bytes, SHA-256 " + digest);
  return {
    archive: archive,
    text: text,
    receipt: receipt
  };
}

// A model block is the only generated part of the readable runtime. Reusing that
// file as a template avoids a second copy of the encoder/decoder source code.
function buildPacked(model, info, template, tag) {
  const transformed = packModel(model);
  const stored = zlib.deflateRawSync(transformed, {
    level: 9
  });
  const metadata = {
    name: "ProbZip",
    format: info.format,
    tag: tag,
    maxOrder: MAX_ORDER,
    modelBytes: model.length,
    modelBudget: info.modelBudget,
    contextCount: info.contextCount,
    alphabetSize: info.alphabetSize,
    modelSha256: sha256(model),
    storedModelBytes: stored.length,
    transformedModelBytes: transformed.length,
    storedModelSha256: sha256(stored),
    training: {
      strings: info.training.uniqueTrainingStrings,
      utf8Bytes: info.training.trainingUtf8Bytes,
      languages: info.training.dictionary.languages
    }
  };
  const block = JSON.stringify({
    info: metadata,
    model: stored.toString("base64")
  }, null, 2);
  const startMarker = "/* PROBZIP_MODEL_START */";
  const endMarker = "/* PROBZIP_MODEL_END */";
  const start = template.indexOf(startMarker) + startMarker.length;
  const end = template.indexOf(endMarker);
  if (start < startMarker.length || end < start) throw new Error("Missing model template markers");
  return template.slice(0, start) + "\n" + block + "\n" + template.slice(end);
}

// Verify the generated artifact before replacing a codec: its model must unpack
// exactly, Node and browser APIs must round-trip multilingual and binary inputs.
// This is a training-time integrity check, not a separate repository test suite.
function verifyBuild(source, model, texts, tag) {
  const start = source.indexOf("/* PROBZIP_MODEL_START */") + "/* PROBZIP_MODEL_START */".length;
  const end = source.indexOf("/* PROBZIP_MODEL_END */");
  const definition = JSON.parse(source.slice(start, end));
  const sandbox = {
    TextEncoder: TextEncoder,
    TextDecoder: TextDecoder,
    atob: s => Buffer.from(s, "base64").toString("binary")
  };
  // Expose the internal unpacker only in this isolated verification instance.
  const instrumented = source.replace("const codec = createProbZipUnicode(definition);", "root.restoreModel = unpackProbZipStorage; const codec = createProbZipUnicode(definition);");
  vm.runInNewContext(instrumented, sandbox);
  if (!sandbox.restoreModel) throw new Error("Missing verification hook");
  const restored = sandbox.restoreModel(zlib.inflateRawSync(Buffer.from(definition.model, "base64")), model.length);
  if (!model.equals(Buffer.from(restored))) throw new Error("Model storage is not lossless");
  const cases = [ "", "\0\ufeff\ud800", "Petra Novotná, Jabloňová 28, 602 00 Brno", "東京都新宿区西新宿一丁目", "台北市中正區忠孝東路123號", "Nguyễn Văn An, Hà Nội", "สมชาย สุขใจ ถนนสุขุมวิท", "İpek Yılmaz, İstanbul" ];
  const step = Math.max(1, Math.floor(texts.length / 300));
  for (let i = 0; i < texts.length; i += step) cases.push(texts[i]);
  const commonjs = {
    module: {
      exports: {}
    },
    TextEncoder: TextEncoder,
    TextDecoder: TextDecoder,
    Buffer: Buffer
  };
  vm.runInNewContext(source, commonjs);
  for (const codec of [ sandbox.ProbZip, commonjs.module.exports ]) {
    for (const text of cases) {
      const packed = codec.encode(text);
      if (codec.decode(packed) !== text || packed[0] !== 0 && packed[0] !== tag) throw new Error("Generated codec round-trip failed");
    }
    const bytes = Uint8Array.from({
      length: 256
    }, (_, i) => i);
    if (!Buffer.from(codec.decodeBytes(codec.encodeBytes(bytes))).equals(Buffer.from(bytes))) throw new Error("Binary round-trip failed");
  }
}

// ZIP extraction accepts only the named member and bounded stored/DEFLATE data.
function extract(archive, name) {
  let end = archive.length - 22;
  while (end >= Math.max(0, archive.length - 65557) && archive.readUInt32LE(end) !== 101010256) end--;
  if (end < Math.max(0, archive.length - 65557)) throw new Error("Invalid ZIP directory");
  let p = archive.readUInt32LE(end + 16);
  for (let i = 0; i < archive.readUInt16LE(end + 10); i++) {
    if (archive.readUInt32LE(p) !== 33639248) throw new Error("Invalid ZIP entry");
    const n = archive.readUInt16LE(p + 28), e = archive.readUInt16LE(p + 30), c = archive.readUInt16LE(p + 32);
    if (archive.toString("utf8", p + 46, p + 46 + n) === name) {
      const method = archive.readUInt16LE(p + 10), size = archive.readUInt32LE(p + 24), local = archive.readUInt32LE(p + 42);
      if (size > 1e8 || archive.readUInt32LE(local) !== 67324752) throw new Error("Invalid ZIP member");
      const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28), packed = archive.subarray(start, start + archive.readUInt32LE(p + 20));
      const result = method === 8 ? zlib.inflateRawSync(packed, {
        maxOutputLength: 1e8
      }) : method === 0 ? packed : null;
      if (!result || result.length !== size) throw new Error("ZIP extraction mismatch");
      return result;
    }
    p += 46 + n + e + c;
  }
  throw new Error("Missing ZIP member " + name);
}

// These parsers handle the published CSV and ODS schemas, not arbitrary documents.
function csv(line) {
  return [ ...line.matchAll(/(?:^|,)(?:"((?:[^"]|"")*)"|([^,]*))/g) ].map(m => m[1] === undefined ? m[2] : m[1].replace(/""/g, '"'));
}

function unxml(s) {
  return s.replace(/<[^>]*>/g, "").replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, x) => x[0] === "#" ? String.fromCodePoint(x[1].toLowerCase() === "x" ? parseInt(x.slice(2), 16) : Number(x.slice(1))) : {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'"
  }[x]);
}

// Partition source entities before adding numeric variants. Keep the same 90/5/5
// split as the released model; excluded examples never contribute counts.
async function prepareBase(downloads) {
  const [geo, japan, taiwan] = downloads;
  const geonames = geo.receipt, addresses = [ japan.receipt, taiwan.receipt ];
  const training = new Set, held = {
    validation: [],
    test: []
  }, sourceRecords = {
    geonames: {},
    japan: {},
    taiwan: {}
  }, groups = {
    geonames: {},
    japan: {},
    taiwan: {}
  };
  function add(source, id, texts) {
    // Japan groups the clean district across municipalities; Taiwan groups the
    // Chinese street name and its English translation before augmentation.
    const h = hash(source === "geonames" ? id : source + ":" + id), split = h % 100 < 90 ? "training" : h % 100 < 95 ? "validation" : "test";
    sourceRecords[source][split] = (sourceRecords[source][split] || 0) + 1;
    (groups[source][split] ??= new Set).add(id);
    for (const text of new Set(texts.filter(s => s.length >= 2 && Buffer.byteLength(s) <= 200 && !/[\x00-\x1f\ufffd]/.test(s)))) {
      if (split === "training") training.add(text);
      else held[split].push({
        source: source,
        id: id,
        text: text
      });
    }
  }
  for (const line of geo.text.toString("utf8").trim().split("\n")) {
    const c = line.split("\t");
    add("geonames", c[0], [ c[1], c[2], ...c[3].split(",") ].filter(s => Buffer.byteLength(s) <= 160));
  }
  for (const line of japan.text.toString("utf8").trim().split(/\r?\n/)) {
    const c = csv(line), district = c[8]?.replace(/（.*?）/g, "").trim();
    if (!district || /以下に掲載|一円|次のビル/.test(district)) continue;
    const base = c[6] + c[7] + district, h = hash(base), number = h % 9 + 1 + "-" + (h % 199 + 1) + "-" + (h % 12 + 1);
    add("japan", district, [ base, c[7] + district, district, c[3] + c[4] + c[5], base + number, district + number + ", " + c[7] ]);
  }
  const xml = taiwan.text.toString("utf8");
  for (const row of xml.matchAll(/<table:table-row\b[^>]*>([\s\S]*?)<\/table:table-row>/g)) {
    const cells = [ ...row[1].matchAll(/<table:table-cell\b[^>]*>([\s\S]*?)<\/table:table-cell>/g) ].map(m => [ ...m[1].matchAll(/<text:p\b[^>]*>([\s\S]*?)<\/text:p>/g) ].map(p => unxml(p[1])).join(""));
    const street = cells[0];
    if (!street || street === "中文街路名稱") continue;
    const h = hash(street), n = h % 399 + 1;
    add("taiwan", street, [ street, cells[1] || "", street + n + "號", street + n + "号", n + " " + cells[1] ]);
  }
  // General separators and numeric house-number patterns, not benchmark rows.
  for (let n = 1; n <= 1e3; n++) for (const s of [ " " + n + ", ", " " + n + "-1, ", n + "號, ", n + "号, ", n + "丁目" ]) training.add(s);
  const texts = [ ...training ].sort(), seen = new Set;
  for (const split of [ "validation", "test" ]) {
    const rows = held[split].filter(r => {
      if (training.has(r.text) || seen.has(r.text)) return false;
      seen.add(r.text);
      return true;
    });
    // Equal evaluation sample counts by source, rather than letting aliases swamp addresses.
    held[split] = [ "geonames", "japan", "taiwan" ].flatMap(source => rows.filter(r => r.source === source).sort((a, b) => hash(a.id + "|" + a.text) - hash(b.id + "|" + b.text) || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0)).slice(0, 1e3));
  }
  const splitGroups = Object.fromEntries(Object.entries(groups).map(([source, splits]) => [ source, Object.fromEntries(Object.entries(splits).map(([s, ids]) => [ s, ids.size ])) ]));
  const manifest = {
    sources: [ geonames, ...addresses ],
    sourceRecords: sourceRecords,
    splitGroups: splitGroups,
    uniqueTrainingStrings: texts.length,
    trainingUtf8Bytes: texts.reduce((n, s) => n + Buffer.byteLength(s), 0),
    trainingTextSha256: sha256(texts.join("\n")),
    split: "FNV-1a ID modulo 100: train 0..89, validation 90..94, test 95..99. GeoNames groups by entity ID (same split as v1); Japan by cleaned district string across municipalities; Taiwan by Chinese street name with translation. Split before all variants. Held-out exact training strings removed; test also excludes all validation strings; up to 1000 hash-ranked distinct strings per source per split.",
    extraction: "GeoNames names/aliases; Japanese prefecture, city, district (parenthetical notes removed), kana aliases; Taiwanese Chinese streets and English translations. Deterministic house-number suffixes are synthetic augmentation, not verified addresses. 5000 generic numeric/separator strings. No personal-address records read from these three sources."
  };
  return {
    texts: texts,
    manifest: manifest,
    held: held
  };
}

// Read tar members in memory, including USTAR long-path prefixes. No archive
// path is written to disk. Dictionary aliases stay grouped before partitioning.
function readTar(tar) {
  const files = [];
  for (let p = 0; p + 512 <= tar.length; ) {
    const leaf = tar.toString("utf8", p, p + 100).split("\0")[0];
    if (!leaf) break;
    const prefix = tar.toString("ascii", p + 257, p + 262) === "ustar" ? tar.toString("utf8", p + 345, p + 500).split("\0")[0] : "";
    const name = prefix ? prefix + "/" + leaf : leaf;
    const n = parseInt(tar.toString("ascii", p + 124, p + 136).replace(/\0/g, "").trim(), 8) || 0;
    if (!Number.isSafeInteger(n) || n < 0 || p + 512 + n > tar.length) throw new Error("Invalid tar member");
    const type = tar[p + 156];
    if (type === 0 || type === 48) files.push({
      name: name,
      bytes: tar.subarray(p + 512, p + 512 + n)
    });
    p += 512 + Math.ceil(n / 512) * 512;
  }
  return files;
}

// Synthetic house numbers supply separators; these are not real personal addresses.
function variants(term) {
  const title = term.replace(/^\p{L}/u, c => c.toUpperCase());
  return [ ...new Set([ term, title, term + " 27, ", "42 " + term + ", " ]) ];
}

// Add address vocabulary from all dictionary language folders with weight eight;
// geography-only strings have weight one. Deduplicate before counting.
async function prepare(downloads) {
  const base = await prepareBase(downloads);
  const {archive: archive, receipt: receipt} = downloads[3];
  const files = readTar(zlib.gunzipSync(archive, {
    maxOutputLength: 1e8
  }));
  const license = files.find(f => f.name.endsWith("/LICENSE"))?.bytes.toString("utf8");
  if (!license?.includes("Copyright (c) 2015 openvenues")) throw new Error("Missing libpostal license");
  const legacyHeld = base.held;
  // Preserve the existing source benchmark split. This is a leakage exclusion,
  // not a compression-score-based choice of training data or model parameters.
  const reserved = new Set(Object.values(legacyHeld).flat().map(r => r.text));
  const groups = new Map, languageStats = {}, dictionaryFiles = [];
  for (const f of files) {
    const match = f.name.match(/resources\/dictionaries\/([^/]+)\/(.+\.txt)$/);
    if (!match) continue;
    const language = match[1];
    dictionaryFiles.push({
      path: match[0],
      bytes: f.bytes.length,
      sha256: sha256(f.bytes)
    });
    for (const line of f.bytes.toString("utf8").split(/\r?\n/)) {
      const terms = [ ...new Set(line.split("|").map(s => s.trim()).filter(s => s.length >= 2 && Buffer.byteLength(s) <= 160 && !/[\x00-\x1f\ufffd]/.test(s))) ];
      if (!terms.length) continue;
      const id = language + ":" + terms[0], key = hash("libpostal:" + id) % 100, split = key < 90 ? "training" : key < 95 ? "validation" : "test";
      const group = groups.get(id) || {
        id: id,
        language: language,
        split: split,
        terms: new Set
      };
      for (const t of terms) group.terms.add(t);
      groups.set(id, group);
    }
  }
  const weights = new Map(base.texts.map(t => [ t, 1 ])), added = new Set;
  let excludedGroups = 0;
  for (const g of groups.values()) {
    const s = languageStats[g.language] ??= {
      trainingGroups: 0,
      validationGroups: 0,
      testGroups: 0,
      trainingTerms: 0,
      addedTrainingStrings: 0
    };
    const texts = [ ...new Set([ ...g.terms ].flatMap(variants)) ];
    if (texts.some(t => reserved.has(t))) {
      excludedGroups++;
      continue;
    }
    s[g.split + "Groups"]++;
    if (g.split === "training") {
      s.trainingTerms += g.terms.size;
      for (const t of texts) {
        if (!added.has(t)) {
          s.addedTrainingStrings++;
          added.add(t);
        }
        weights.set(t, Math.max(weights.get(t) || 0, 8));
      }
    }
  }
  const texts = [ ...weights.keys() ].sort(), source = {
    ...receipt,
    licenseText: license,
    dictionaryFiles: dictionaryFiles.length,
    dictionaryBytes: dictionaryFiles.reduce((s, f) => s + f.bytes, 0),
    dictionaryInventorySha256: sha256(JSON.stringify(dictionaryFiles))
  };
  const manifest = {
    ...base.manifest,
    sources: [ ...base.manifest.sources, source ],
    uniqueTrainingStrings: texts.length,
    trainingUtf8Bytes: texts.reduce((s, t) => s + Buffer.byteLength(t), 0),
    trainingTextSha256: sha256(texts.join("\n")),
    weightedTrainingSha256: sha256(texts.map(t => weights.get(t) + "\t" + t).join("\n")),
    dictionary: {
      languages: Object.keys(languageStats).filter(k => k !== "all").sort(),
      languageStats: languageStats,
      sharedFolder: "all",
      weight: 8,
      dictionaryVariantStrings: added.size,
      newTrainingStrings: texts.length - base.texts.length,
      excludedGroupsMatchingLegacyHeldout: excludedGroups,
      split: "FNV-1a(libpostal:language:canonical-term) modulo 100, 90/5/5; aliases kept together. Only training groups contribute counts; groups touching reserved base-source strings are excluded.",
      augmentation: "Each alias, uppercase initial, alias + 27 comma, and 42 + alias comma. Original source words include public given-name/surname lists; no private address records."
    },
    extraction: "Base sources: " + base.manifest.extraction + " Additional source: libpostal public address/name vocabulary with grouped aliases and deterministic numeric variants. Base strings weight 1; dictionary variants weight 8 (max across duplicates). No address benchmark read."
  };
  return {
    texts: texts,
    weights: weights,
    manifest: manifest
  };
}

// Inverse of the runtime model unpacker: prefix/delta coding before DEFLATE.
function packModel(model) {
  let pos = 0;
  const out = [];
  const u16 = () => {
    const v = model.readUInt16LE(pos);
    pos += 2;
    return v;
  };
  const u32 = () => {
    const v = model.readUInt32LE(pos);
    pos += 4;
    return v;
  };
  const variable = v => {
    if (!Number.isInteger(v) || v < 0 || v > 268435455) throw new Error("Invalid model integer");
    do {
      const b = v % 128;
      v = Math.floor(v / 128);
      out.push(b + (v ? 128 : 0));
    } while (v);
  };
  const count = u32(), alphabet = u16();
  variable(count);
  variable(alphabet);
  let last = 0;
  for (let i = 0; i < alphabet; i++) {
    const cp = u32();
    variable(cp - last);
    last = cp;
    variable(u16());
  }
  variable(u16());
  let previous = [];
  for (let i = 0; i < count; i++) {
    const order = model[pos++], key = [];
    for (let j = 0; j < order; j++) key.push(u16());
    let shared = 0;
    while (shared < key.length && shared < previous.length && key[shared] === previous[shared]) shared++;
    out.push(shared * 8 + key.length - shared);
    for (let j = shared; j < key.length; j++) variable(key[j]);
    const n = u16();
    variable(n);
    let prior = 0;
    for (let j = 0; j < n; j++) {
      const id = u16();
      variable(id - prior);
      prior = id;
      out.push(model[pos++]);
    }
    previous = key;
  }
  if (pos !== model.length) throw new Error("Unexpected model tail");
  return Buffer.from(out);
}

// Training counts Unicode symbols and contexts up to order five. Allocate a
// share of the finite model budget to each observed script, then choose contexts
// by estimated training information gain per stored byte. This is a heuristic,
// not a guarantee of optimal held-out compression.
const scriptNames = [ "Latin", "Cyrillic", "Arabic", "Han", "Hiragana", "Katakana", "Hangul", "Thai", "Lao", "Khmer", "Myanmar", "Devanagari", "Bengali", "Gurmukhi", "Gujarati", "Oriya", "Tamil", "Telugu", "Kannada", "Malayalam", "Sinhala", "Tibetan", "Hebrew", "Greek", "Armenian", "Georgian", "Ethiopic", "Thaana", "Cherokee", "Canadian_Aboriginal", "Mongolian" ];

const scriptTests = scriptNames.map(s => [ s, new RegExp("\\p{Script=" + s + "}", "u") ]);

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

// Classify a Unicode point. Common punctuation inherits a context's script later.
function script(cp) {
  const c = String.fromCodePoint(cp);
  for (const [s, re] of scriptTests) if (re.test(c)) return s;
  return /[\p{Letter}\p{Mark}]/u.test(c) ? "Other" : null;
}

async function train(options, downloads) {
  const template = fs.readFileSync(path.join(__dirname, "probzip.js"), "utf8");
  const current = require("./probzip.js");
  const tag = options.tag ?? current.info.tag;
  const limit = LIMIT;
  const stem = "probzip";
  const {texts, weights, manifest} = await prepare(downloads);
  console.log("Training " + texts.length + " strings with " + manifest.dictionary.languages.length + " dictionary language groups");
  const counts = new Map;
  for (const text of texts) {
    const weight = weights.get(text);
    for (const c of text) {
      const cp = c.codePointAt(0);
      counts.set(cp, (counts.get(cp) || 0) + weight);
    }
  }
  const alphabet = [ ...new Set([ ...Array.from({
    length: 128
  }, (_, i) => i), ...[ ...counts ].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 19872).map(r => r[0]) ]) ].sort((a, b) => a - b);
  const ids = new Map(alphabet.map((cp, i) => [ cp, i ])), escape = alphabet.length, groups = alphabet.map(script), groupCounts = {};
  const normalized = alphabet.map(cp => String.fromCharCode(ids.get(cp >= 65 && cp <= 90 ? cp + 32 : cp >= 48 && cp <= 57 ? 48 : cp) ?? escape));
  normalized[escape] = String.fromCharCode(escape);
  for (let i = 0; i < alphabet.length; i++) if (groups[i] && counts.get(alphabet[i])) groupCounts[groups[i]] = (groupCounts[groups[i]] || 0) + counts.get(alphabet[i]);
  const priorities = {
    Latin: 32,
    Cyrillic: 10,
    Arabic: 7,
    Han: 12,
    Hiragana: 3,
    Katakana: 2,
    Hangul: 4,
    Thai: 4,
    Greek: 3,
    Hebrew: 3,
    Devanagari: 3,
    Bengali: 2
  };
  const totalPriority = Object.keys(groupCounts).reduce((s, g) => s + (priorities[g] || 1), 0), shares = Object.fromEntries(Object.keys(groupCounts).map(g => [ g, (priorities[g] || 1) / totalPriority ]));
  const bucket = key => {
    for (let i = key.length - 1; i >= 0; i--) {
      const g = groups[key.charCodeAt(i)];
      if (g) return g;
    }
    return "Latin";
  };
  const corpus = texts.map(text => ({
    weight: weights.get(text),
    text: Array.from(text, c => String.fromCharCode(ids.get(c.codePointAt(0)) ?? escape)).join("")
  }));
  const frequencies = new Map, rootCounts = new Float64Array(escape + 1);
  for (let row = 0; row < corpus.length; row++) {
    const {text: text, weight: weight} = corpus[row];
    let context = "";
    for (let i = 0; i < text.length; i++) {
      const id = text.charCodeAt(i);
      rootCounts[id] += weight;
      for (let order = 1; order <= context.length; order++) {
        const key = context.slice(-order);
        frequencies.set(key, (frequencies.get(key) || 0) + weight);
      }
      context = (context + normalized[id]).slice(-MAX_ORDER);
    }
    if (row && row % 5e5 === 0) console.log("Context pass " + row + "; " + frequencies.size + " candidates");
  }
  const candidates = Object.fromEntries(Object.keys(shares).map(g => [ g, [] ]));
  for (const [key, n] of frequencies) if (key.length === 1 || n >= 4) candidates[bucket(key)].push([ key, n ]);
  frequencies.clear();
  const tables = new Map;
  for (const [g, list] of Object.entries(candidates)) {
    list.sort((a, b) => (b[0].length === 1) - (a[0].length === 1) || b[1] - a[1] || compare(a[0], b[0]));
    for (const [key] of list.slice(0, Math.ceil(35e4 * shares[g]) + 1e3)) tables.set(key, new Map);
    candidates[g] = null;
  }
  console.log("Distribution pass: " + tables.size + " contexts, " + alphabet.length + " symbols, " + Object.keys(shares).length + " script buckets");
  for (const {text: text, weight: weight} of corpus) {
    let context = "";
    for (let i = 0; i < text.length; i++) {
      const id = text.charCodeAt(i);
      if (id !== escape) for (let order = 1; order <= context.length; order++) {
        const table = tables.get(context.slice(-order));
        if (table) table.set(id, (table.get(id) || 0) + weight);
      }
      context = (context + normalized[id]).slice(-MAX_ORDER);
    }
  }
  const totalRoot = rootCounts.reduce((a, b) => a + b, 0), totals = new Map([ ...tables ].map(([key, t]) => [ key, [ ...t.values() ].reduce((a, b) => a + b, 0) ])), rows = [];
  for (const [key, table] of tables) {
    if (!table.size) continue;
    let backoff, backoffTotal = totalRoot;
    for (let n = key.length - 1; n > 0; n--) {
      const k = key.slice(-n);
      if (tables.has(k)) {
        backoff = tables.get(k);
        backoffTotal = totals.get(k);
        break;
      }
    }
    const total = totals.get(key), pairs = [ ...table ].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 64).sort((a, b) => a[0] - b[0]);
    let gain = 0;
    for (const [id, n] of pairs) {
      const base = (backoff ? backoff.get(id) : rootCounts[id]) || 1;
      gain += n * Math.log2(n / total / (base / backoffTotal));
    }
    const size = 3 + key.length * 2 + pairs.length * 3, scale = Math.min(1, 255 / Math.max(...pairs.map(p => p[1])));
    rows.push({
      key: key,
      group: bucket(key),
      size: size,
      score: gain / size,
      observations: total,
      pairs: pairs.map(([id, n]) => [ id, Math.max(1, Math.round(n * scale)) ])
    });
  }
  rows.sort((a, b) => b.score - a.score || compare(a.key, b.key));
  const firstOrder = rows.filter(r => r.key.length === 1).sort((a, b) => b.observations - a.observations || compare(a.key, b.key));
  // Quantize frequencies and serialize selected contexts in sorted ID order.
  function selectModel(budget) {
    const overhead = 8 + alphabet.length * 6, contextBudget = budget - overhead, kept = [], selected = new Set, storage = Object.fromEntries(Object.keys(shares).map(g => [ g, 0 ]));
    let modelBytes = overhead;
    const keep = r => {
      kept.push(r);
      selected.add(r.key);
      storage[r.group] += r.size;
      modelBytes += r.size;
    };
    // Reserve a foundation of first-order contexts separately for each script.
    // Cap successor fanout so common alphabets do not require enormous tables.
    for (const r of firstOrder) if (storage[r.group] + r.size <= Math.floor(contextBudget * shares[r.group] * .4)) keep(r);
    for (const r of rows) if (!selected.has(r.key) && storage[r.group] + r.size <= Math.floor(contextBudget * shares[r.group])) keep(r);
    for (const r of rows) if (!selected.has(r.key) && modelBytes + r.size <= budget) keep(r);
    kept.sort((a, b) => compare(a.key, b.key));
    const model = Buffer.alloc(modelBytes);
    model.writeUInt32LE(kept.length);
    model.writeUInt16LE(alphabet.length, 4);
    let p = 6;
    for (let i = 0; i < alphabet.length; i++) {
      model.writeUInt32LE(alphabet[i], p);
      p += 4;
      model.writeUInt16LE(Math.max(1, Math.round(rootCounts[i] * 32e3 / totalRoot)), p);
      p += 2;
    }
    model.writeUInt16LE(Math.max(8, Math.round(rootCounts[escape] * 32e3 / totalRoot)), p);
    p += 2;
    for (const r of kept) {
      model[p++] = r.key.length;
      for (let i = 0; i < r.key.length; i++) {
        model.writeUInt16LE(r.key.charCodeAt(i), p);
        p += 2;
      }
      model.writeUInt16LE(r.pairs.length, p);
      p += 2;
      for (const [id, f] of r.pairs) {
        model.writeUInt16LE(id, p);
        p += 2;
        model[p++] = f;
      }
    }
    if (p !== model.length) throw new Error("Model length mismatch");
    const coverage = Object.fromEntries(Object.keys(shares).map(g => [ g, {
      weightedCodePoints: groupCounts[g],
      contexts: 0,
      firstOrderContexts: 0,
      bytes: storage[g]
    } ]));
    for (const r of kept) {
      coverage[r.group].contexts++;
      if (r.key.length === 1) coverage[r.group].firstOrderContexts++;
    }
    const info = {
      name: "ProbZip Unicode " + limit / 1024 + " KiB Multilingual",
      format: stem + "-v1",
      algorithm: "Static multilingual Unicode contexts, PPM escape/full exclusion, 32-bit arithmetic coding",
      maxOrder: MAX_ORDER,
      modelBytes: model.length,
      modelBudget: budget,
      contextCount: kept.length,
      alphabetSize: alphabet.length,
      modelSha256: sha256(model),
      scriptStorageBytes: storage,
      training: {
        ...manifest,
        weightedTrainingCodePoints: totalRoot,
        scriptCoverage: coverage,
        selection: {
          candidateContexts: 35e4,
          extraCandidatesPerScript: 1e3,
          minimumWeightedContextObservations: 4,
          maxSuccessors: 64,
          scriptShares: shares,
          firstOrderBudgetFraction: .4,
          rule: "Reserve 40% per-script storage for frequent first-order contexts, then training likelihood gain per byte; redistribute unused storage. All observed scripts receive their own share; rare unclassified scripts share Other. All candidate ranking uses weighted training only. Full ASCII and up to 19872 most frequent additional code points; other characters use literal escape.",
          fileBudget: {
            maxJavaScriptBytes: limit,
            method: "Binary search raw model budgets up to all candidate tables and measure complete readable JS. No evaluation scores read; heuristic, not a claim of global optimality."
          }
        }
      }
    };
    return {
      model: model,
      info: info
    };
  }
  // Keep the released model exactly when the source snapshots are unchanged.
  // Otherwise measure the entire readable file, including comments and Base64.
  let candidate = selectModel(RELEASED_BUDGET);
  let best = null, trials = 0;
  const makeOutput = candidate => {
    candidate.info.format = candidate.info.modelSha256 === current.info.modelSha256 && tag === current.info.tag ? current.info.format : "probzip-" + tag + "-" + candidate.info.modelSha256.slice(0, 12);
    return buildPacked(candidate.model, candidate.info, template, tag);
  };
  let output = makeOutput(candidate);
  if (candidate.info.modelSha256 === current.info.modelSha256 && Buffer.byteLength(output) <= limit) {
    best = {
      ...candidate,
      output: output
    };
  } else {
    // The sum of every candidate table is a finite raw-model upper bound.
    // The actual limit is checked against the complete JavaScript below.
    let low = 8 + alphabet.length * 6;
    let high = low + rows.reduce((sum, row) => sum + row.size, 0);
    while (low <= high) {
      const budget = Math.floor((low + high) / 2);
      candidate = selectModel(budget);
      output = makeOutput(candidate);
      trials++;
      if (Buffer.byteLength(output) <= limit) {
        best = {
          ...candidate,
          output: output
        };
        low = budget + 1;
      } else high = budget - 1;
      console.log("Size search " + trials + ": " + Buffer.byteLength(output) + " / " + limit + " bytes");
    }
  }
  if (!best) throw new Error("No model fits the complete " + limit / 1024 + " KiB JavaScript budget");
  // Protect the shipped format and a previously written custom output. A tag
  // identifies probabilities, so reusing it for another model would corrupt data.
  const publishedFiles = new Set([
    path.join(__dirname, "probzip.js"),
    options.output
  ]);
  for (const file of publishedFiles) {
    if (!fs.existsSync(file)) continue;
    const previous = require(file);
    if (previous.info.tag === tag && previous.info.modelSha256 !== best.info.modelSha256) {
      throw new Error("Format tag " + tag + " already belongs to a different model in " + path.basename(file) + "; choose an unused --tag. Nothing was overwritten.");
    }
  }
  verifyBuild(best.output, best.model, texts, tag);
  const report = {
    ...best.info,
    tag: tag,
    javascriptBytes: Buffer.byteLength(best.output),
    nodeVersion: process.version,
    zlibVersion: process.versions.zlib,
    sources: manifest.sources
  };
  fs.writeFileSync(path.join(options.cache, "training.json"), JSON.stringify(report, null, 2) + "\n");
  fs.mkdirSync(path.dirname(options.output), {
    recursive: true
  });
  fs.writeFileSync(options.output + ".part", best.output);
  fs.renameSync(options.output + ".part", options.output);
  console.log(JSON.stringify({
    output: options.output,
    javascriptBytes: report.javascriptBytes,
    tag: tag,
    modelSha256: best.info.modelSha256,
    contexts: best.info.contextCount,
    trials: trials
  }, null, 2));
}

// Download sequentially for clear progress and modest peak memory. --download-only
// exercises the same download, archive parsing and receipts as actual training.
async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node --max-old-space-size=8192 train-probzip.cjs [--tag N] [--output probzip-new.js] [--cache DIR] [--refresh] [--download-only]\nComplete JavaScript budget: 256 KiB.");
    return;
  }
  const downloads = [];
  for (const source of SOURCES) downloads.push(await downloadSource(source, options));
  if (options.downloadOnly) return;
  await train(options, downloads);
}

if (require.main === module) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
