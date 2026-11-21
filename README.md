# ProbZip

Samostatný bezeztrátový kompresor krátkých textů a adres. Soubor **`probzip.js` obsahuje encoder, decoder i natrénovaný model**, funguje v prohlížeči i v Node.js a nepotřebuje žádné závislosti ani připojení k internetu. JavaScript je čitelný a komentovaný; pouze data modelu jsou zabalena pomocí DEFLATE a uložena jako Base64.

Celý soubor má **261 768 bajtů (255,63 KiB)**, tedy méně než 256 KiB. Velikost zahrnuje kód, model i komentáře, před případnou HTTP kompresí.

ProbZip je samostatný nástupce projektu [bpezip](https://github.com/Tomas-M/bpezip). Původní implementace BPE zůstává v původním repozitáři pro referenci; ProbZip používá pravděpodobnostní model a aritmetické kódování.

## Použití

V prohlížeči:

```html
<meta charset="utf-8">
<script src="probzip.js"></script>
<script>
  const text = "Petra Novotná, Jabloňová 28, 602 00 Brno";
  const packed = ProbZip.encode(text); // Uint8Array včetně hlavičky
  const restored = ProbZip.decode(packed);
  console.log(packed.length, restored);
</script>
```

V Node.js:

```javascript
const ProbZip = require('./probzip.js');
const packed = ProbZip.encode('Nguyễn Văn An, 27 Nguyễn Trãi, Hà Nội');
console.log(ProbZip.decode(packed));

// Pro binární data používej bajtové API, které zachová všechny hodnoty.
const original = Uint8Array.of(0, 255, 17, 128);
const restored = ProbZip.decodeBytes(ProbZip.encodeBytes(original));
```

| API | Význam |
| --- | --- |
| `encode(string)` | Vrací komprimovaný záznam jako `Uint8Array`. |
| `decode(Uint8Array)` | Obnoví přesně původní JavaScriptový řetězec. |
| `encodeBytes(Uint8Array)` | Komprimuje UTF-8/WTF-8; ostatní binární data uloží přímo. |
| `decodeBytes(Uint8Array)` | Obnoví původní bajty. Přijímá i Node.js `Buffer`. |
| `clearCache()` | Uvolní rozbalený model; při příštím použití se znovu načte. |
| `info` | Identita modelu, jeho hash, rozměry a základní trénovací statistiky. |

Výstup je binární. Base64 pro přenos v JSON přidává přibližně třetinu velikosti. Maximální vstup i deklarovaný rozbalený záznam mají 64 MiB; pro velké soubory tento kompresor není optimalizovaný.

## Model a formát

Jeden společný model předpovídá další Unicode znak podle nejvýše pěti předchozích znaků. Používá ústup ke kratším kontextům, PPM escape s vylučováním již vyzkoušených znaků a 32bitové aritmetické kódování. Písma mají při trénování vyhrazené podíly prostoru; za běhu se nezkoušejí samostatné jazykové modely. Znaky mimo model se kódují doslovně, takže lze zachovat libovolný jazyk, emoji, BOM, NUL i nepárové UTF-16 surrogáty.

První bajt je **87 pro tento model**, nebo **0 pro nekomprimovaný záznam**. Neoznačuje jazyk ani písmo. Za 87 následuje délka původních bajtů jako ULEB128 a aritmetický bitový proud. Za 0 následují původní bajty. Encoder vybírá kratší záznam včetně hlavičky, výsledek proto nikdy nepřesáhne původní počet bajtů o více než jeden. Kontroly formátu nenahrazují kontrolní součet.

Formát ProbZipu není kompatibilní s původním bpezip. Pro dekódování uložených dat musí být dostupný stejný model, který se použil při jejich kompresi.

Před odstraněním benchmarků byla ověřena shoda všech 5 650 syntetických adres: **274 119 → 150 648 bajtů**, tedy **54,96 % původní velikosti**. Jde o dosavadní syntetický soubor, nikoli záruku výsledku na skutečných adresách nebo obecné próze.

## Rychlost a paměť

Runtime předpočítává součty četností při načtení modelu a používá jedno pomocné pole pro vylučování znaků. Původní verze toto pole o velikosti 31 732 bajtů vytvářela pro každý komprimovaný nebo dekomprimovaný záznam. Nová verze každému volání přiděluje vlastní rozsah číselných značek; ošetřuje jejich přetečení i přerušení dekódování chybou. `clearCache()` uvolní také toto pole.

**Model, formát 87 i komprimované bajty zůstávají stejné.** Úprava zrychluje zpracování a omezuje dočasné alokace; kompresní poměr nemění. Soubor narostl proti prvnímu vydání o 699 bajtů.

Porovnání s prvním vydáním (`b52eb69`), měřeno 21. 11. 2026 na Windows x64, Node.js 24.15.0 a Intel Core i5-8250U:

| Vstupy | Operace | Původní čas na řetězec | Nový čas na řetězec | Zrychlení |
| --- | --- | ---: | ---: | ---: |
| 16 adres z `test.html` | Komprese | 76,29 µs | 53,63 µs | 1,42× |
| 16 adres z `test.html` | Dekomprese | 96,64 µs | 67,83 µs | 1,42× |
| 3 311 textů vynechaných z trénování | Komprese | 29,88 µs | 12,22 µs | 2,45× |
| 3 311 textů vynechaných z trénování | Dekomprese | 34,12 µs | 13,73 µs | 2,49× |

Větší vzorek obsahuje 1 000 záznamů GeoNames, 1 000 japonských adresních komponent, 1 000 tchajwanských uličních komponent a 311 záznamů libpostal. Nejde o 3 311 úplných adres se jmény. Zdrojové snapshoty odpovídají hashům v `NOTICE`; texty pocházejí z testovací části rozdělení, bez přesných překryvů s trénováním a validační částí. Obě verze zde dávají **65 587 → 31 223 bajtů**. U 16 adres zůstává výsledek **958 → 634 bajtů**.

Časy jsou mediány pěti samostatných procesů pro každou kombinaci verze, vstupů a operace, se střídáním pořadí verzí. Po první dávce a 1 500 zahřívacích voláních se měřilo 600 opakování souboru 16 adres, respektive šest opakování většího souboru. Měřený čas zahrnuje běžnou práci garbage collectoru; neobsahuje počáteční načtení modelu.

Paměť se zaznamenávala zvlášť před tímto zahříváním, po první dávce, pomocí `process.resourceUsage().maxRSS`. Na 3 311 textech klesl medián špičky RSS při kompresi **58,67 → 49,13 MiB** a při dekompresi **79,95 → 53,67 MiB**. U 16 adres mají obě verze špičku přibližně 49 MiB. Jde o celý proces včetně Node.js, vstupů a prvního rozbalení modelu; hodnoty závisejí na prostředí a pracovním zatížení.

Ověření zahrnovalo shodu výstupních bajtů a obnovu 4 336 textů, 300 binárních vstupů, 1 553 poškozených nebo zkrácených záznamů, pokračování po chybě, přetečení číselných značek a vymazání cache. Prošly také kontroly v prostředí bez Node.js API a sestavení souboru prostřednictvím trenéru.

## Trénování a stažení dat

Vše potřebné je v **`train-probzip.cjs`**. Používá pouze vestavěné moduly Node.js; žádné `npm install`. Ověřeno na Node.js 24.15.0. Trénování má výrazně větší nároky na RAM než samotné použití kompresoru; příkaz níže povoluje až 8 GiB pro JavaScriptovou haldu, počítej i s pamětí navíc pro systém a buffery.

Pouze stáhnout a ověřit veřejné zdroje:

```sh
node train-probzip.cjs --download-only
```

Natrénovat nový model a uložit ho do samostatného souboru, stále do 256 KiB:

```sh
node --max-old-space-size=8192 train-probzip.cjs --tag 89 --output probzip-new.js
```

Číslo 89 je příklad nového formátu. Přiložený model používá 87; číslo 88 zůstává rezervované pro odstraněný experimentální model. **Každý odlišný model potřebuje vlastní nepoužité číslo 1–255**, protože decoder musí mít stejné pravděpodobnosti jako encoder. Starý soubor si ponech, pokud s ním potřebuješ číst stará data. Trenér chrání číslo přiloženého modelu i existujícího cílového souboru a odmítá rezervované číslo 88; přehled dalších čísel dříve vydaných modelů si musí udržovat aplikace.

Bez `--output` se výsledek po ověření uloží do `probzip.js`. Bez `--tag` lze reprodukovat stávající model, pokud zdroje a výběr tabulek zůstaly stejné:

```sh
node --max-old-space-size=8192 train-probzip.cjs
```

Trenér čte `probzip.js` jako šablonu čitelného runtime a nahrazuje blok mezi značkami `PROBZIP_MODEL_START` a `PROBZIP_MODEL_END`. Pevný limit **256 KiB** platí pro celý výsledný soubor včetně modelu a komentářů. Objekt v prohlížeči se jmenuje `ProbZip`. Trenér nepoužívá minifikátor. Před zápisem ověří rozbalení modelu a zpětné dekódování textů i bajtů v Node.js a v izolovaném prostředí bez Node.js API.

Stažené archivy, jejich SHA-256 a trénovací protokol ukládá do ignorované složky `.probzip-training/`. Příště použije cache. Přepínač `--refresh` stáhne aktuální data znovu, `--cache CESTA` změní umístění a `--help` vypíše parametry. Cache lze po trénování celou smazat. Žádné trénovací databáze nejsou součástí repozitáře.

| Zdroj | Co se využívá | Stažená velikost přiloženého modelu |
| --- | --- | ---: |
| [GeoNames cities500](https://download.geonames.org/export/dump/cities500.zip) | Místní názvy a jejich jazykové varianty | 13 935 407 B |
| [Japan Post](https://www.post.japanpost.jp/service/search/zipcode/download/utf/zip/utf_ken_all.zip) | Japonské oblasti, města, čtvrti a kana | 2 033 286 B |
| [Chunghwa Post](https://data.gov.tw/dataset/152276) | Čínské a anglické názvy ulic na Tchaj-wanu | 357 604 B |
| [libpostal](https://github.com/openvenues/libpostal/tree/25099c506612b34b23b1bfe286ca6321fcf06f35/resources/dictionaries) | Adresní slovníky, zkratky a veřejné slovníky jmen | 5 611 187 B |
| **Celkem** | | **21 937 484 B (20,92 MiB)** |

Přiložený model byl natrénován na **1 965 856 různých řetězcích**, celkem **37 992 926 bajtů UTF-8**. libpostal doplňuje 833 souborů v 60 jazykových složkách a jedné společné složce. Model uchovává 7 932 znaků a 7 621 kontextů, rozdělených mezi 32 skupin písem včetně skupiny ostatních písem. To neznamená stejně dobrou kompresi pro všechny jazyky.

Zdroje se rozdělují podle identit před vytvořením variant: 90 % trénování, zbývající části se do četností nezapočítávají. Přidávají se deterministické vzory čísel domů a oddělovačů. Adresní slovníky mají váhu 8, základní místní názvy váhu 1. Model vybírá tabulky podle odhadovaného přínosu na bajt, s rezervou pro jednotlivá písma. Nejde o natrénování na soukromých záznamech osob ani o použití původního parseru libpostal.

GeoNames a poštovní zdroje se průběžně aktualizují. Aktuální stažení tedy nemusí reprodukovat přiložený model ani mít stejnou velikost. Konkrétní snapshot libpostal je připnutý na commit; hashe přiloženého modelu a jeho zdrojů jsou v `NOTICE`. Pro přesnou reprodukci je nutné uchovat stejné archivy a prostředí Node.js.

## Soubory a licence

- `probzip.js` — kompresor včetně modelu do 256 KiB.
- `test.html` — ukázka komprese a dekomprese 16 adres s výpisem do konzole.
- `train-probzip.cjs` — stahování dat, jejich příprava, trénování a zápis nové verze.
- `README.md`, `LICENSE`, `NOTICE` — návod, GPL-2.0 pro kód a povinné atribuce zdrojů modelu.

Při distribuci zachovej licence a atribuce v `LICENSE` a `NOTICE`.
