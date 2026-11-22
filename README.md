# ProbZip

A standalone lossless compressor for short texts and addresses. **`probzip.js` includes the encoder, decoder, and trained model**, runs in browsers and Node.js, and requires no dependencies or internet connection. The JavaScript is readable and commented; only the model data is packed with DEFLATE and stored as Base64.

The complete file is **260,476 bytes (254.37 KiB)**, below the 256 KiB limit. This includes the code, model, and comments, before any HTTP compression.

ProbZip is a standalone successor to [bpezip](https://github.com/Tomas-M/bpezip). The original BPE implementation remains in its repository for reference; ProbZip uses a probabilistic model and arithmetic coding.

## Usage

In a browser:

```html
<meta charset="utf-8">
<script src="probzip.js"></script>
<script>
  const text = "Petra Novotná, Jabloňová 28, 602 00 Brno";
  const packed = ProbZip.encode(text); // Uint8Array including the header
  const restored = ProbZip.decode(packed);
  console.log(packed.length, restored);
</script>
```

In Node.js:

```javascript
const ProbZip = require('./probzip.js');
const packed = ProbZip.encode('Nguyễn Văn An, 27 Nguyễn Trãi, Hà Nội');
console.log(ProbZip.decode(packed));

// Use the byte API for binary data to preserve every byte value.
const original = Uint8Array.of(0, 255, 17, 128);
const restored = ProbZip.decodeBytes(ProbZip.encodeBytes(original));
```

| API | Description |
| --- | --- |
| `encode(string)` | Returns a compressed record as a `Uint8Array`. |
| `decode(Uint8Array)` | Restores the exact original JavaScript string. |
| `encodeBytes(Uint8Array)` | Compresses UTF-8/WTF-8; stores other binary data directly. |
| `decodeBytes(Uint8Array)` | Restores the original bytes. Also accepts a Node.js `Buffer`. |
| `clearCache()` | Releases the unpacked model; it is loaded again on the next use. |
| `info` | The format tag and model sizes used during loading (`tag`, `modelBytes`, `storedModelBytes`, `transformedModelBytes`). |

The output is binary. Encoding it as Base64 for JSON transport adds roughly one third to its size. Both the input and the declared uncompressed record size are limited to 64 MiB; this compressor is not optimized for large files.

## Model and format

A single shared model predicts the next Unicode character from up to five preceding characters. It uses backoff to shorter contexts, PPM escape with exclusion of characters already considered, and 32-bit arithmetic coding. Scripts receive reserved shares of the model budget during training; separate language models are not tried at runtime. Characters outside the model are encoded literally, preserving any language, emoji, BOM, NUL, and unpaired UTF-16 surrogates.

The first byte is **87 for this model**, or **0 for an uncompressed record**. It does not identify a language or script. Tag 87 is followed by the original byte length as ULEB128 and the arithmetic-coded bitstream. Tag 0 is followed by the original bytes. The encoder chooses the shorter record, including its header, so the result never exceeds the original byte count by more than one. Format validation is not a substitute for a checksum.

The ProbZip format is not compatible with the original bpezip. Decoding stored data requires the same model that was used to compress it.

Before the benchmarks were removed, round-trip correctness was verified for all 5,650 synthetic addresses: **274,119 → 150,648 bytes**, or **54.96% of the original size**. These results describe that synthetic dataset and do not guarantee performance on real addresses or general prose.

## Speed and memory

The runtime precomputes cumulative frequency sums when loading the model and uses a single scratch array for character exclusion. The original version allocated this 31,732-byte array for every compressed or decompressed record. The new version assigns each call its own range of numeric markers, handling both marker overflow and decoding interrupted by an error. `clearCache()` also releases this array.

**The model, format 87, and compressed bytes remain unchanged.** The optimization speeds up processing and reduces temporary allocations without changing the compression ratio. It added 699 bytes compared with the first release.

Comparison with the first release (`b52eb69`), measured on November 21, 2026, using Windows x64, Node.js 24.15.0, and an Intel Core i5-8250U:

| Inputs | Operation | Original time per string | New time per string | Speedup |
| --- | --- | ---: | ---: | ---: |
| 16 addresses from `test.html` | Compression | 76.29 µs | 53.63 µs | 1.42× |
| 16 addresses from `test.html` | Decompression | 96.64 µs | 67.83 µs | 1.42× |
| 3,311 texts held out from training | Compression | 29.88 µs | 12.22 µs | 2.45× |
| 3,311 texts held out from training | Decompression | 34.12 µs | 13.73 µs | 2.49× |

The larger sample contains 1,000 GeoNames records, 1,000 Japanese address components, 1,000 Taiwanese street components, and 311 libpostal records. These are not 3,311 complete addresses with names. The source snapshots match the hashes in `NOTICE`; the texts come from the test split, with no exact overlaps with the training or validation splits. Both versions produce **65,587 → 31,223 bytes** on this sample. The result for the 16 addresses remains **958 → 634 bytes**.

Times are medians from five separate processes for each combination of version, input set, and operation, alternating the order of the versions. After an initial batch and 1,500 warm-up calls, measurements covered 600 repetitions of the 16-address dataset or six repetitions of the larger dataset. The measured time includes normal garbage collection but excludes the initial model load.

Memory was recorded separately before warm-up, after the initial batch, using `process.resourceUsage().maxRSS`. On the 3,311 texts, median peak RSS decreased from **58.67 → 49.13 MiB** for compression and **79.95 → 53.67 MiB** for decompression. On the 16 addresses, both versions peak at approximately 49 MiB. These figures cover the entire process, including Node.js, inputs, and the initial model unpacking; they depend on the environment and workload.

Validation covered identical output bytes and round-trip recovery for 4,336 texts and 300 binary inputs, handling of 1,553 corrupted or truncated records, continued operation after an error, numeric marker overflow, and cache clearing. Checks in an environment without Node.js APIs and file generation through the trainer also passed.

## Training and data downloads

Everything needed is in **`train-probzip.cjs`**. It uses only built-in Node.js modules; no `npm install` is required. Verified on Node.js 24.15.0. Training requires substantially more RAM than using the compressor; the command below allows up to 8 GiB for the JavaScript heap, with additional memory needed for the system and buffers.

To download and verify the public sources without training:

```sh
node train-probzip.cjs --download-only
```

To train a new model and save it to a separate file, still within 256 KiB:

```sh
node --max-old-space-size=8192 train-probzip.cjs --tag 89 --output probzip-new.js
```

Tag 89 is an example of a new format tag. The bundled model uses 87; tag 88 remains reserved for a removed experimental model. **Every distinct model needs its own unused tag from 1–255**, because the decoder must use the same probabilities as the encoder. Keep the old file if you need to read data compressed with it. The trainer protects the tags of the bundled model and any existing output file, and rejects reserved tag 88; the application must track any other tags used by previously released models.

Without `--output`, the result is saved to `probzip.js` after validation. Without `--tag`, the existing model can be reproduced if the sources and table selection remain the same:

```sh
node --max-old-space-size=8192 train-probzip.cjs
```

The trainer reads `probzip.js` as a template for the readable runtime and replaces the block between `PROBZIP_MODEL_START` and `PROBZIP_MODEL_END`. The hard **256 KiB** limit applies to the entire output file, including the model and comments. The browser object is named `ProbZip`. The trainer does not use a minifier. Before writing, it verifies model unpacking and text and byte round trips in Node.js and in an isolated environment without Node.js APIs.

Downloaded archives, their SHA-256 hashes, and the `training.json` training log are stored in the ignored `.probzip-training/` directory. The log also includes the model hash and training statistics. Subsequent runs reuse the cache. Use `--refresh` to download current data again, `--cache PATH` to change the cache location, and `--help` to list the options. The entire cache can be deleted after training. No training databases are included in the repository.

| Source | Data used | Download size for the bundled model |
| --- | --- | ---: |
| [GeoNames cities500](https://download.geonames.org/export/dump/cities500.zip) | Place names and their language variants | 13,935,407 B |
| [Japan Post](https://www.post.japanpost.jp/service/search/zipcode/download/utf/zip/utf_ken_all.zip) | Japanese regions, cities, neighborhoods, and kana | 2,033,286 B |
| [Chunghwa Post](https://data.gov.tw/dataset/152276) | Chinese and English street names in Taiwan | 357,604 B |
| [libpostal](https://github.com/openvenues/libpostal/tree/25099c506612b34b23b1bfe286ca6321fcf06f35/resources/dictionaries) | Address dictionaries, abbreviations, and public name dictionaries | 5,611,187 B |
| **Total** | | **21,937,484 B (20.92 MiB)** |

The bundled model was trained on **1,965,856 distinct strings**, totaling **37,992,926 UTF-8 bytes**. libpostal contributes 833 files across 60 language directories and one shared directory. The model stores 7,932 characters and 7,621 contexts, distributed across 32 script groups, including an other-scripts group. This does not imply equally good compression for every language.

Sources are split by identity before variants are generated: 90% is used for training, while the remaining splits do not contribute to frequency counts. Deterministic house-number and separator patterns are added. Address dictionaries have a weight of 8, and base place names a weight of 1. The model selects tables by estimated benefit per byte, with reserved space for individual scripts. It is not trained on private personal records and does not use the original libpostal parser.

GeoNames and the postal sources are updated regularly, so current downloads may not reproduce the bundled model or have the same size. The libpostal snapshot is pinned to a commit; hashes of the bundled model and its sources are listed in `NOTICE`. Exact reproduction requires preserving the same archives and Node.js environment.

## Files and licensing

- `probzip.js` — the compressor and model, within 256 KiB.
- `test.html` — a compression and decompression demo for 16 addresses, with console output.
- `train-probzip.cjs` — data downloading, preparation, training, and writing a new version.
- `README.md`, `LICENSE`, `NOTICE` — documentation, GPL-2.0 for the code, and required attribution for model sources.

When distributing, preserve the licenses and attribution in `LICENSE` and `NOTICE`.
