# GenCAD 1.4 import

## UNITS inference when the record is missing

Some GenCAD files (notably vendor exports such as ASUS board files) omit the `UNITS` record in `$HEADER`. The parser then cannot scale geometry to millimetres and refuses the file with `parse.error.unitsMissing`.

TRACE does **not** guess a unit. Instead it infers one from the file's own pin-to-pin distances, which fall on standard surface-mounted package pitches (0402/0603/0805/1206/1210/1812/2512, SOIC, QFP, BGA, DRAM, connectors) only under the correct scale.

### How the algorithm decides

For each candidate scale `s` (mm per source unit, chosen from `MIL` = 0.0254, `MM` = 1, `INCH` = 25.4):

1. **Board size gate** — scale the board's bounding box (from `PLACE` records). A plausible PCB is between 10 mm and 600 mm on each side.
2. **Pitch match** — for every pin-to-pin distance `d` within a package (`SHAPE`), compute `d·s` and the relative error to the nearest standard pitch (0.4 … 25.4 mm). Score = median relative error (lower is better).
3. **Known-type fit** — fraction of distances landing in the realistic component-pitch band `[0.3, 6.0]` mm (SMD 2-terminal, IC, DRAM, BGA, connector ranges all fall inside).
4. **Decisive win** — the best scale must beat the runner-up by a 3× margin on median pitch error, have a known-type fit above 50 %, and a median error below 15 %.

If no candidate is decisive, the file is refused with the original `parse.error.unitsMissing` message (no guess).

### Pseudocode

```
function detectGencadUnits(sections):
    packages = group PIN positions by SHAPE (one package = one shape's pins)
    distances = all pairwise pin distances within a package, capped at N
    if len(distances) < 8: return null
    bbox = bounding box of PLACE records (absolute board coordinates)
    candidates = [MIL=0.0254, MM=1, INCH=25.4]
    for each scale s in candidates:
        mmDist = [d * s for d in distances]
        relErr = median( min over standard_pitches p of |mm - p| / p )
        knownFit = count(mm in [0.3, 6.0]) / len(mmDist)
        plausible = bbox is null or (10 <= bbox.w*s <= 600 and 10 <= bbox.h*s <= 600)
        score[s] = (relErr, knownFit, plausible)
    plausible = candidates where plausible
    if plausible is empty: return null
    best = plausible with lowest medianRelErr
    if best.knownFit < 0.5 or best.medianRelError > 0.15: return null
    if runnerUp exists and best.medianRelError > runnerUp.medianRelError * 0.8: return null
    return best.scale
```

### Flowchart

```
[ start ]
   |
   v
sections = sectionsFrom(text)
header = sections.HEADER
unitsRows = header filter UNITS
   |
   +-- if unitsRows.length != 1 --> fail("parse.error.unitsMissing")   [guard: no inference]
   |
   +-- if unitsRows.length == 1 --> use declared unit, return scale
   |
   v
(no UNITS record present)
   |
   v
detected = detectGencadUnits(sections)
   |
   +-- detected == null --> fail("parse.error.unitsMissing")   [no guess]
   |
   +-- detected != null --> inject "UNITS <name>" line into in-memory text
                             re-parse with the inferred unit
                             add warning: "unit inferred from pin-to-pin distances"
   |
   v
[ return scale ]
```

### How this file is stored in git

Git stores plain text files; there is no special block format. Pseudocode goes inside a **fenced code block** (three backticks) so it renders in a monospaced font on GitHub and anywhere else Markdown is rendered. Flowcharts are plain text (ASCII) inside the same kind of fence, so they render without any tool — GitHub also renders `mermaid` fenced blocks as diagrams, but ASCII is safer and works offline.

The `docs/GENCAD.md` file itself is a normal Markdown file tracked in the repository, just like `docs/I18N.md` and the other format guides.
