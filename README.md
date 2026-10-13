<p align="center">
  <img src="assets/icon.png" width="96" height="96" alt="TRACE Boardviewer icon">
</p>

<h1 align="center">TRACE Boardviewer</h1>

<h2 align="center"><a href="https://github.com/trace-boardviewer/trace-boardviewer/releases/tag/v1.3.3">Download TRACE Boardviewer 1.3.3</a></h2>

<p align="center"><strong>Free, open-source boardviewer for electronics repair.</strong><br>
Open a boardview or PCB file (KiCad, EAGLE, selected Allegro/Altium layouts and more) next to its schematic and PDF datasheets, offline and without an account.</p>

<p align="center"><a href="https://trace-boardviewer.github.io/"><strong>Website · 1-minute demo · guides</strong></a></p>

<p align="center">
  <a href="https://github.com/trace-boardviewer/trace-boardviewer/releases/tag/v1.3.3"><img src="docs/readme/download-windows.svg" width="248" height="56" alt="Download for Windows"></a>
  <a href="https://github.com/trace-boardviewer/trace-boardviewer/releases/tag/v1.3.3"><img src="docs/readme/download-apple-silicon.svg" width="248" height="56" alt="Download for macOS, experimental"></a>
  <a href="https://github.com/trace-boardviewer/trace-boardviewer/releases/tag/v1.3.3"><img src="docs/readme/download-linux.svg" width="248" height="56" alt="Download for Linux, experimental"></a>
  <a href="https://donate.stripe.com/7sYaEZeET2op8PxaGE5EY00"><img src="docs/readme/support.svg" width="248" height="56" alt="Support TRACE"></a>
</p>

<p align="center">Thank you for trying TRACE and sharing your feedback. Special thanks to everyone who uses the app and supports its development. Support is always optional.</p>

**Quick compatibility · 1.3.3**

| Status | Formats or feature | Scope |
| --- | --- | --- |
| ✓ | GenCAD 1.4, KiCad PCB, EAGLE board XML, Altium PcbDoc, EasyEDA Pro | Selected documented variants; see the full table for exact coverage. |
| ✓ | Landrex/TestLink BRD, TOPTEST BRD2, Honhan BDV, BVR, ASC companion trio | Supported variants and geometry estimates are listed in the full table. |
| ✓ | Jet BV, BV2, TVW, FZ/CAE, Unisoft F2B, Mentor Neutral, Tebo ICT, Fabmaster FARC/FAZ | Selected documented variants; companion and geometry limits apply. |
| ✓ | KiCad, EAGLE and Altium schematics; PDFs and images | Offline viewing and search; scanned-PDF OCR is optional and English-only. |
| ⚠ | Native Cadence Allegro BRD | Selected layouts; up to 240 MiB and 4 million declared objects. Other layouts are refused. |
| ⚠ | Samsung CAD; CAST CST | Samsung scale/dialects are not fully established; CST imports documented component layers only. |
| ⚠ | IPC-2581; IPC-D-356 | Checked with open-design files written by KiCad 9 `kicad-cli`; vendor writers are unverified. |
| ⚠ | ODB++ | Open-design files written by KiCad 9 `kicad-cli`; selected copper pads, lines, arcs and drilled holes are displayed, but pours and text are not read. |
| ⚠ | HyperLynx, Fabmaster FATF, EasyEDA Standard, CSV/TSV, ZIP, XZZ | Draft or selected-subset support; encrypted XZZ needs a session key. |
| ✗ | Native PADS SDB, BRD_V1.0 encoded boards, VS2 listings, Gerber as a complete board | Recognized with an explanation but not imported as a complete electrical board. |
| ✗ | PCB editing and copper routing | Not provided. |

Windows x64 is the supported desktop target. macOS Apple silicon and Linux x86-64 downloads remain experimental. The v1.3.3 Windows package passed a startup check; Linux packages passed startup and visible-window checks under Ubuntu 24.04 WSL2. These were startup checks, not full feature acceptance; WSL2 is not native Linux acceptance. [Full file types and exact limits](docs/SUPPORT.md).

<p align="center">Free and open source (MIT) · no account, no telemetry · 
<a href="https://ko-fi.com/tracerboardview">Ko-fi</a> · 
<a href="https://github.com/trace-boardviewer/trace-boardviewer/issues/new?template=bug_report.yml">Report a bug</a> · 
<a href="docs/SUPPORT.md">Supported formats</a></p>

<p align="center"><strong>TRACE Boardviewer 1.3.3 is the current stable release.</strong> The optional update check offers stable releases and never downloads or installs an update. See the <a href="CHANGELOG.md">full changes and release history</a>.</p>

<p align="center">Open a board next to its schematic and datasheets, find a net or a part across all of them, keep your repair notes with the board, and work without an account or a connection.</p>

<p align="center"><strong>Jump to:</strong>
<a href="#run-the-portable-app">Run the app</a> ·
<a href="#run-on-linux-experimental">Linux</a> ·
<a href="#features">Features</a> ·
<a href="docs/SUPPORT.md">Supported formats</a> ·
<a href="#languages">Languages</a> ·
<a href="#supported-data-and-limitations">Limitations</a> ·
<a href="#develop-and-build">Build from source</a> ·
<a href="#share-and-contribute">Contribute</a> ·
<a href="CHANGELOG.md">Changelog</a> ·
<a href="SECURITY.md">Security</a></p>

<p align="center"><img src="docs/readme/hero.png" width="900" alt="TRACE Boardviewer 1.3.2 with a synthetic board: the GND net searched, its parts highlighted, and the selected part linked to its schematic sheet"></p>

An offline boardviewer and repair workspace for Windows, with experimental builds for macOS and Linux. Open a board (GenCAD plus several boardview, EDA and encrypted formats — see the [exact support table](docs/SUPPORT.md)), attach its schematics, PDF datasheets and reference images, search across all of them, cross-probe between board, schematic and documents, and keep local repair notes that survive a restart. The interface is available in eight languages; see [Languages](#languages). The support notice shown at start opens the Stripe or Ko-fi page in your browser only when you click one of its buttons, and Not now skips it.

The update check is off until you choose it at the first start. When it is on, TRACE asks GitHub once at start whether a newer stable release exists and shows a dismissible link; it never downloads or installs an update. Settings can change this choice. Optional payment verification contacts the receipt service only when you choose Verify payment, sending the app's random support reference. Settings > Network lists permitted features and hosts and a clearable request log with time, feature, host and result. Board files, notes, payment details and credentials are never uploaded by the app.

## What's new in 1.3.3

1.3.2 was not released separately; its changes ship in this release.

- **Large boards:** zoom and pan are faster. In a synthetic benchmark on a graphics card (median of three runs), the 95th-percentile zoom frame time fell by 35% at 100,000 pins and by 44% at 250,000 pins, and the pan frame time by 32% and 24%.
- **EasyEDA Pro:** V3 projects are read with their components, pads, nets and board outline, and `.epro2` projects can be picked in the open dialog. Bottom-side parts are now rotated correctly at every angle. A project that cannot be read is refused, and the message names the reason.
- **ODB++ copper:** copper pads, copper lines, arcs and drilled holes are drawn in the 2D board view, with the copper's rotation and mirror applied. Copper pours and text are still not read.
- **In-app bug report:** describe a problem, review the exact preview of what will be sent, and send it explicitly through a separate receiver. Drafts can be kept locally.
- **Accessibility:** a visible focus ring on the board, catalogue labels for three accessible controls, and a 3:1 contrast for control borders.
- **Settings file:** a settings file locked by another program no longer delays the start, and its state is shown as a persistent notice. If it is locked while the app runs, a notice appears and the change is saved once the file is writable again.
- **Smaller package:** the bundled app archive shrank from about 94 MB to 22 MB; the Windows portable download is about 5% smaller.
- **Languages:** more interface texts, including the export dialog, the workspace file status and the refusal messages, are shown in all eight languages.
- **macOS:** the macOS build requires macOS 13 or later.

The [release notes for 1.3.3](release-notes/1.3.3.md) list every fix, and the [complete changelog](CHANGELOG.md) has the details.

## New since 1.3.0

- **More board formats:** native Allegro BRD, Jet BV, BV2, Unisoft F2B, Mentor Neutral, Tebo ICT pairs and Fabmaster FARC/FAZ; ODB++ models, IPC-2581, IPC-D-356, EasyEDA Standard/Pro, HyperLynx, Fabmaster FATF and CSV/TSV pin lists. Validation and geometry limits differ by reader; the [generated table](docs/SUPPORT.md) gives the exact scope.
- **Schematics and scanned documents:** Altium SchDoc joins KiCad and EAGLE schematics. Bundled English OCR makes scanned PDF pages searchable offline, with confidence marks, progress and Cancel.
- **Faster, cancellable work:** background search, a shared board index, GenCAD/KiCad import progress, a parser watchdog and memory-only ZIP board/companion opening. Previous-query results cannot be selected while a newer search is loading. Fixed extensionless companion files have an all-files chooser option.
- **Reliable notes and viewing:** stable component/pin identities, backups during migration, visible unresolved notes, consistent part classification, schematic counterpart selection and corrected sheet fitting. Older BDV/ASC notes remain unresolved if shortened headers make their target uncertain; a note RC2 already attached to the wrong target cannot be safely repaired automatically.
- **Optional support and networking:** hourly reminders and the heart remain skippable; Retry keeps keyboard focus available and announces progress; provider-confirmed support hides both for a calendar year, including offline use. Damaged local receipt storage is reported and left intact, with Try again after storage is restored; Stripe remains available if local reference setup fails. FZ/CAE tries published default format keys; other key entry has Skip and never activates or unlocks the application.
- **Safer imports and clearer failures:** expanded classic boardview variants, bounded malformed-input handling, strict counts/checksums, local content-free format diagnostics and specific explanations for unsupported PADS, BRD_V1.0, VS2 and layer variants.

The [complete changelog](CHANGELOG.md) includes every improvement and fix since 1.3.0, with Windows, macOS and Linux limits and the developer foundations that have no dedicated interface yet.

**Found a bug?** Thank you for testing and for telling us. Choose **Report a bug** in the app to describe the issue and optionally include a minimal technical summary. Review the exact preview, edit it, or cancel; nothing is sent until you choose **Send**. Reports go from the app to a separate receiver, with no GitHub account required. Saving a draft is optional; drafts and retry records expire after seven days, and expired local records are removed on the next report access. Failed or uncertain reports are never sent again automatically; retry is manual and reuses the same report. There are no attachments. A local helper can flag some paths and token-like text, but it cannot catch everything and removes text only when you explicitly choose to remove it. You can also open GitHub's [issue form manually](https://github.com/trace-boardviewer/trace-boardviewer/issues/new?template=bug_report.yml). Please do not include proprietary or customer boardview details.

## Run the portable app

Download `TRACE-Boardviewer-<version>.exe` from a published GitHub release, or build it with the instructions below. The EXE contains the complete application and its Electron runtime. Copying that one file is enough: no installer, Node.js, source folder or `win-unpacked` directory is required to run it.

Open a board file with **Open** (or the localized equivalent) or drag it into the window; the [support table](docs/SUPPORT.md) lists the accepted formats. TRACE restores the last available board at the next launch.

The portable launcher extracts its runtime (about 500 MB) into a private temporary folder of its own for every launch (`%TEMP%\nsXXXX.tmp\app`; while the instance runs that folder holds about 1.1 GB in total, because the launcher keeps the packed archive and a second extracted copy next to the runtime) and removes it on normal exit, so several running instances — and a second launch that hands a board to a running instance — never touch each other's runtime. If a launch is killed (for example with Task Manager) or crashes, its folder may stay behind in `%TEMP%`; delete it by hand once no TRACE process is running. A 0-byte `%TEMP%\trace-boardviewer-portable-init.lock` is shared by all launches (it serializes their start-up for a few milliseconds) and can stay; it is safe to delete when no TRACE launch is starting. Settings, recent files and notes are stored separately in `%APPDATA%\trace-boardviewer`. Notes are associated with the board file's content hash, so renaming the board keeps its notes. Board files are read without modification. No board data is uploaded; the app works offline.

Release builds target Windows x64, Linux x86-64 and macOS Apple silicon. The macOS build requires macOS 13 or later and is an experimental download (`TRACE-Boardviewer-<version>-mac-arm64.zip`): it is ad-hoc signed and not notarized, so macOS (Gatekeeper) may block a downloaded copy. This page gives no way around that block: do not remove the quarantine flag or change Gatekeeper settings to open the app. Use a signed and notarized release once one is published. The arm64 build was run once on an Apple M3 as a development check, which is not an acceptance test of a downloaded, signed build; Intel Macs and a universal build are not packaged or tested (see [docs/MAC_VALIDATION.md](docs/MAC_VALIDATION.md)).

## Run on Linux (experimental)

Each release from 1.3.0 on carries two packages of the same x86-64 build. They are built and smoke-tested automatically on Ubuntu 24.04 (GitHub Actions, virtual X display). The v1.3.3 packages also passed startup and visible-window checks in Ubuntu 24.04 on WSL2; this is not a native Linux desktop or full feature acceptance test. Other distributions, desktop environments and Wayland sessions are not tested. Neither package is signed: check it against the `.sha256` file next to it (`sha256sum -c <file>.sha256`).

- **Ubuntu 24.04 (the tested configuration): `TRACE-Boardviewer-<version>-linux-amd64.deb`.** Install it with `sudo apt install ./TRACE-Boardviewer-<version>-linux-amd64.deb` and start TRACE Boardviewer from the application menu (or run `trace-boardviewer`). The package installs to `/opt/TRACE Boardviewer`. On systems with AppArmor 4, such as Ubuntu 24.04, it also installs the profile `/etc/apparmor.d/trace-boardviewer`, which lets Chromium's sandbox use user namespaces under Ubuntu's restriction. Remove it with `sudo apt remove trace-boardviewer`; your settings and notes stay.
- **Other distributions, not tested by TRACE: `TRACE-Boardviewer-<version>-linux-x86_64.AppImage` (portable, nothing is installed).** Make it executable (`chmod +x`) and run it. Its static AppImage runtime needs no libfuse2. Where unprivileged user namespaces are allowed (Fedora, Debian, Arch and openSUSE by default, none of them tested by TRACE) Chromium's sandbox works as usual. Ubuntu 23.10 and newer restrict them, so there the AppImage can only run without the sandbox; TRACE then asks before it starts that way (Quit is the default, and "Do not ask again" remembers a yes). Use the `.deb` on Ubuntu.

Settings, recent files and notes are stored in `~/.config/trace-boardviewer` (`$XDG_CONFIG_HOME/trace-boardviewer`); on Windows they are in `%APPDATA%\trace-boardviewer` (expected from the packaged app's name; not yet confirmed on a native Windows build). To keep them next to the AppImage instead, create a folder named like the AppImage file plus `.config` beside it (AppImage portable mode); rename the AppImage to a fixed name first if you want to keep that folder across updates. The update check works as on Windows: it only links to the release page, and you download the new package yourself.

Known limits: the window icon on GNOME under Wayland comes from an installed desktop entry (the `.deb` installs one; for the AppImage use an AppImage integration tool), Electron's ASAR integrity check is not available on Linux, and only x86-64 is built. See [docs/LINUX.md](docs/LINUX.md) for the sandbox, what is tested, troubleshooting and building the packages yourself.

## Features

- Search by component reference, value, package and net name — across the board, structured schematics and the text of attached PDFs, with results grouped by source and page/sheet.
- **Technician workspace:** Board, Schematic and Documents tabs, a split view with an adjustable divider, and a compact status area. Attach PDFs, images and KiCad/EAGLE/Altium schematics to a board; they are remembered per board (by SHA-256, with a board-relative path) and restored after a restart. Moved files are found again, missing ones can be relinked, changed ones are never adopted silently.
- **Schematic cross-probe:** exact reference/pin matching between board and schematic with disagreements, unmatched and ambiguous parts listed explicitly (never guessed); hierarchical sheets, repeated sub-sheets and multi-unit parts keep their identity.
- **PDF viewer:** offline pdf.js rendering, text search, selectable text, bookmarks and page notes; board references found in the text link to board parts. **Recognize text** makes scanned pages searchable with bundled English OCR; recognized words show their confidence and only exact, sufficiently confident board names become links.
- **Images:** PNG/JPEG/WebP and sanitized SVG with zoom, rotation, bookmarks and notes; millimetre measurement only after an explicit two-point calibration.
- Notes per component or per pin with technician-entered voltage/resistance values; project export of only the documents you tick.
- Open a board directly from a ZIP with its companion files; an archive containing more than one board is refused with the candidate names.
- Board view (zoom, position, rotation, side) is remembered per board; the **Link and aliases** panel lists reference/net differences between board and schematic and lets you confirm aliases explicitly.
- Component and pin inspection with a connected-component list and net highlighting.
- Top and mirrored bottom views, rotation, cursor-centred zoom, pan, board fit and selection fit.
- Two-point distance measurement in millimetres, with pin snapping.
- Per-component notes, recent boards and persistent appearance settings.
- Skippable support reminders at startup and once per hour during use; they wait for imports and other dialogs. A provider-confirmed Stripe or Ko-fi payment hides both the reminder and heart for one calendar year, including offline use. Verification sends only a random support code and is optional. Key entry can also be skipped.
- **Format diagnostic report:** analyze an unreadable board locally from Help, review counts and format facts, and save or copy the report yourself. No file content or key is included, and nothing is uploaded.
- **In-app bug reports:** review the exact report before sending it to a separate receiver. Drafts and retries stay on your device; sending and retrying always require your action.
- Workshop and Focus layouts and dark/light/system themes.
- Interface available in Hungarian, English, German, French, Italian, Slovak, Polish and Ukrainian, with instant switching. Translation coverage varies by screen; some newer workspace text remains English (see [Languages](#languages)).
- Rendering optimizations for dense nets and large boards.

| Action | Shortcut |
| --- | --- |
| Open board | Ctrl + O |
| Search | Ctrl + F |
| Fit board | F |
| Rotate | R |
| Measure | M |
| Toggle labels | L |
| Component note | N |
| Zoom in / out | + / − |
| Workshop / Focus layout | Ctrl + 1 / 2 |
| Clear highlight / measurement | Esc |
| Board / Schematic / Documents tab | Alt + 1 / 2 / 3 |
| Split view on / off | Ctrl + \ |
| Keyboard shortcuts (help) | ? or F1 |

On macOS, Cmd replaces Ctrl and Option replaces Alt.

## Screenshots

Screenshots of TRACE 1.3.2 with synthetic test boards made for this project; no third-party design is shown. More screenshots, a one-minute demo and step-by-step guides are on the [website](https://trace-boardviewer.github.io/).

<table>
<tr>
<td width="50%"><img src="docs/readme/shots/jetson-net.webp" width="440" alt="TRACE Boardviewer with the GND net searched on a synthetic board: the three parts on the net are listed and highlighted"><br><sub>Search a net: the three parts on GND are listed and highlighted (synthetic test board).</sub></td>
<td width="50%"><img src="docs/readme/shots/eagle-split.webp" width="440" alt="TRACE split view: a synthetic board beside its hierarchical KiCad schematic, with the schematic picker and the board selection visible"><br><sub>Board and schematic side by side in the split view (synthetic test boards).</sub></td>
</tr>
<tr>
<td width="50%"><img src="docs/readme/shots/pdf-parts.webp" width="440" alt="A synthetic PDF in TRACE beside the document list, with the search for U10 highlighted in the page"><br><sub>A PDF beside the document list, searched for U10 (synthetic test PDF).</sub></td>
<td width="50%"><img src="docs/readme/shots/jetson-sheets.webp" width="440" alt="A hierarchical synthetic KiCad schematic in TRACE, with its sheet name, breadcrumb and diagnostics line"><br><sub>A hierarchical KiCad schematic with its breadcrumb and diagnostics (synthetic test schematic).</sub></td>
</tr>
<tr>
<td width="50%"><img src="docs/readme/shots/image-measure.webp" width="440" alt="Image viewer in TRACE with a synthetic layout image, pixels only until it is calibrated"><br><sub>An image viewer with its toolbar; the image is not calibrated yet (synthetic layout image).</sub></td>
<td width="50%"><img src="docs/readme/shots/bottom.webp" width="440" alt="Mirrored bottom side of a synthetic board in TRACE, with U10 selected and its nets listed"><br><sub>The mirrored bottom side with a bottom-layer part selected (synthetic test board).</sub></td>
</tr>
</table>

## Languages

| Language | Native name | Code |
| --- | --- | --- |
| Hungarian | Magyar | `hu` |
| English | English | `en` |
| German | Deutsch | `de` |
| French | Français | `fr` |
| Italian | Italiano | `it` |
| Slovak | Slovenčina | `sk` |
| Polish | Polski | `pl` |
| Ukrainian | Українська | `uk` |

- **Choosing the language.** A fresh profile follows the system language when it is one of the eight, otherwise English. A profile saved before language support existed keeps the Hungarian interface it was used with; its theme, layout, recent boards and notes are unchanged. Once you pick a language it is saved with the other settings and always wins.
- **Switching.** Choose **Settings → Language**, where each language is listed by its own name. The interface changes instantly; the open board, selection and notes are not reloaded.
- **Translation coverage.** The interface can be switched among all eight languages. Many core screens, import messages and dialogs are translated. Version 1.3.3 adds workspace file-status text and more search, export, refusal and accessibility labels to the catalogs.
- **Still partly in English.** Some workspace views, labels and messages have not been translated in every language. Translation coverage varies by area; 1.3.3 does not claim a fully translated workspace.
- **What is never translated.** Board data: component references, values, packages, net names and file names. Your own notes stay exactly as you wrote them. Units stay `mm`, and keyboard shortcuts do not change. Numbers and dates follow the selected language's conventions.

Translations live in feature namespaces under `electron/locales/<language>/`. See [CONTRIBUTING.md](CONTRIBUTING.md) to add or improve one.

## Supported data and limitations

**[docs/SUPPORT.md](docs/SUPPORT.md) is the exact, generated support table**: every recognized format with its variants, units, side rules, geometry (real or estimated), key and companion requirements, and what is not supported. Short version:

- **GenCAD 1.4** (`.cad`, `.gcd`), **KiCad PCB**, **EAGLE board XML**, **Altium PcbDoc** and **EasyEDA Pro** are validated with selected real files. The KiCad, EAGLE and Altium schematic readers and the PDF/image viewers also have real-file checks. **IPC-2581** XML boards and **IPC-D-356** netlists were checked against KiCad-written exports; other writers remain unverified. Each reader has its own geometry and record limits in the table.
- **Landrex/TestLink BRD**, **Honhan BDV** and **Samsung CAD** now open real exports checked by the maintainer, with component, pin and test-point counts checked against their records. These checks cover selected exports of each format, not every dialect. BDV outline radii are represented as straight segments; component bodies and some pad sizes are estimated.
- **ASUS FZ / ASRock CAE** open automatically and offline using published default RC6 keys. Real exports of both formats were checked by the maintainer with these defaults; other vendor variants remain unverified. Unencrypted containers and decoded text also open without a key, and another key can be supplied for the session. Board outlines are absent and component bodies are generated; physical scale and pad radii have not been independently confirmed. Missing pad dimensions use disclosed fallback markers.
- **TVW** imports declared components, test points and pins through their explicit physical-pad IDs, preserving pin labels, coordinates, nets, sides and dimensions. The complete records and every pin link in the real exports checked by the maintainer were verified independently. Export variants that are not known yet are refused with a precise error rather than guessed. Compact, height-word and extra-Pascal metadata layouts are covered. Board outlines and copper traces are absent; custom pad shapes use bounding boxes.
- **BVRAW_FORMAT_3** boardviews have selected real-export checks and cross-checks against open tool-written files from the kicad-boardview plugin. These establish the checked variants, not every export dialect.
- **TOPTEST BRD2**, **BVRAW_FORMAT_1**, the **ASC companion trio**, **Jet4 BV**, **BV2**, **Tebo ICT**, **Mentor Neutral**, **Fabmaster FARC/FAZ**, **Unisoft F2B** and selected native **Allegro BRD** layouts now have real-export checks. Fixed extensionless companions can be selected with the translated all-files filter. Physical geometry estimates and supported record subsets are disclosed in the table.
- **Draft readers** include XZZ PCB, HyperLynx, Fabmaster FATF, EasyEDA Standard and recognized CSV/TSV pin lists. Their compatibility is checked on original synthetic fixtures; unfamiliar pin-list columns need parser-level mapping because there is no mapping interface yet.
- **ODB++** product models (`.tgz`, `.tar.gz`, `.zip`) are read: components, pins, nets and the board profile; they are validated with files the open-source kicad-cli wrote from open designs, not with files from the vendor's own software.
- Native PADS SDB, BRD_V1.0 encoded boards, VS2 assembly listings and Gerber are **recognized by their bytes and explained, not imported**. CAST CST imports only documented component-layer mappings; other plane variants remain unsupported. ZIP archives containing one readable board and its companions can be opened directly, subject to archive limits.

Guides on the website: [getting started](https://trace-boardviewer.github.io/getting-started/) · [Linux packages](https://trace-boardviewer.github.io/linux/) · [1-minute demo](https://trace-boardviewer.github.io/demo/) · [KiCad PCB viewer](https://trace-boardviewer.github.io/kicad-pcb-viewer/) · [free EAGLE viewer](https://trace-boardviewer.github.io/eagle-viewer/) · [GenCAD viewer](https://trace-boardviewer.github.io/gencad-viewer/) · [native Allegro BRD viewer](https://trace-boardviewer.github.io/allegro-brd-viewer/) · [Altium PcbDoc and SchDoc viewer](https://trace-boardviewer.github.io/altium-viewer/) · [EasyEDA Pro viewer](https://trace-boardviewer.github.io/easyeda-pro-viewer/) · [ODB++ viewer](https://trace-boardviewer.github.io/odb-viewer/) · [open a .brd file](https://trace-boardviewer.github.io/open-brd-file/) · [open a .bvr file](https://trace-boardviewer.github.io/open-bvr-file/) · [comparison with other boardviewers](https://trace-boardviewer.github.io/boardview-software-comparison/) · [release notes](https://trace-boardviewer.github.io/changelog/)
- Schematics: KiCad `.kicad_sch` (6.0–9.0), KiCad legacy `.sch` (with its `-cache.lib`/`.lib`), EAGLE `.sch` and Altium `.SchDoc` (with sibling sheets and `.PrjPcb` for hierarchy). Altium real-file checks cover flat designs; repeated sheets and project scope have synthetic checks only.
- A PDF is a document, not a boardview or a netlist. Pages without a text layer (scans) can be read with the built-in text recognition (OCR, English, fully offline): recognized words are marked with their confidence, and only exact board names read with high confidence become links.
- Most inputs are limited to 64 MiB. Native Cadence Allegro BRD is the exception: up to 240 MiB and 4 million declared objects. Larger or pathological inputs are rejected with a precise error rather than guessed.

No customer or manufacturer board file is included in this repository or in the application. A `.cad` (or any) extension alone never identifies a format: TRACE detects formats by their bytes.

The importer preserves physical dimensions for pads whose shape the format states exactly. Other pad shapes are approximated by their bounds and reported in the board information panel; if pad dimensions are missing the view uses display markers and says so.

Connection guides show logical net relationships; they are separate from board copper geometry. ODB++ boards also display supported copper pads, lines, arcs and drilled holes in the 2D view. Copper pours, text, fonts, solder mask and silkscreen are not read, so this is not a complete copper-routing view. Schematic connectivity comes from the schematic file (KiCad: computed from wires, junctions, labels and power symbols; EAGLE: the nets the file declares), never from a PDF or an image.

## Develop and build

Use Node.js 24 or newer and the pnpm version declared in `package.json`.

```powershell
pnpm install --frozen-lockfile
pnpm setup:electron
pnpm dev:desktop
```

For a production renderer and native app:

```powershell
pnpm build
pnpm start
```

For a standalone portable Windows x64 release:

```powershell
pnpm package
```

The result is `release/TRACE-Boardviewer-<version>.exe`. The generated `release/win-unpacked` directory is a build intermediate and is not needed alongside the portable EXE. To create only the unpacked app for development, run `pnpm package:dir`. Packaging needs the `pnpm` executable on `PATH` (electron-builder collects the dependency tree with it; `corepack enable` provides it), and the wrapper patch in `patches/` is applied by `pnpm install`, so package only from a checkout installed that way.

Development and QA can use a separate data profile:

```powershell
pnpm dev:desktop --user-data-dir="$PWD\test-results\manual-profile"
```

The desktop shell uses a sandboxed renderer, context isolation and a restricted preload API; the packaged binaries carry Electron fuses that disable `ELECTRON_RUN_AS_NODE` and `NODE_OPTIONS` and load the application only from `app.asar` (integrity-checked on Windows and macOS; Electron does not offer that check on Linux). Project layout:

- `src/`: React UI and the workspace shell (`src/app/`, `src/components/`), canvas and geometry, board adapters and the dispatcher (`src/lib/formats/`), schematic parsers, connectivity and cross-probe (`src/lib/schematic/`, `src/lib/crossprobe.ts`), the PDF layer (`src/lib/pdf/`), images, the workspace model and parser workers.
- `electron/`: desktop window, local file access, the queued atomic store, document/workspace validation, project export and the translation catalogs in `electron/locales/`.
- `docs/`: the [support table](docs/SUPPORT.md) (generated) and the macOS notes.
- `assets/`: original TRACE icons and third-party license notices.
- `tests/`: native-shell, store and workspace checks (plus an opt-in real-Electron smoke test: `TRACE_ELECTRON_SMOKE=1 xvfb-run -a node --test tests/electron-smoke.cjs`).
- `scripts/`: development helpers and optional UI/performance checks.

## Verify changes

The normal test suite uses synthetic data and needs no private board:

```powershell
pnpm test
pnpm test:desktop
pnpm build
```

The technician-workspace flow (open board → attach PDF/image/schematic → search → cross-probe → note → restart → relink) has a synthetic end-to-end check that drives the real built Electron app; it needs a production build and a display (on Linux: `xvfb-run -a`):

```bash
pnpm build
xvfb-run -a pnpm qa:e2e
```

`pnpm qa:workspace` runs the shell's browser checks against a mock workspace (start with `pnpm dev` in another terminal; see the script header for the Chromium note), and the viewers have their own `scripts/qa-pdf-viewer.cjs`, `qa-schematic-viewer.cjs` and `qa-image-viewer.cjs` harness checks.

For synthetic async and renderer interaction checks, install Playwright Chromium and run a Vite server in another terminal with `pnpm dev`. These checks need no external board:

```powershell
pnpm exec playwright install chromium
pnpm qa:races
pnpm qa:renderer
```

The localization checks use their own synthetic board and exercise all eight languages, Unicode notes, settings migration and language restoration. Browser mode uses the running Vite server; the native modes load the production build:

```powershell
pnpm qa:localization --browser
pnpm build
pnpm qa:localization --electron
pnpm package:dir
pnpm qa:localization --packaged
```

Packaged localization checks default to `release/win-unpacked/TRACE Boardviewer.exe`. To verify another build, set `TRACE_PACKAGED_EXE` to the absolute path of its unpacked application executable:

```powershell
$env:TRACE_PACKAGED_EXE = (Resolve-Path 'test-results\final-release\win-unpacked\TRACE Boardviewer.exe').Path
pnpm qa:localization --packaged
```

Real-board UI and performance checks are optional local tools. Supply your own board outside the repository with `TRACE_TEST_BOARD` or `--board=<absolute-path>`. The UI scenario expects `AC1`, `AC15`, `U1`, `VU13` and `AGND_AUD`; adapt the script if your board differs.

```powershell
$env:TRACE_TEST_BOARD = 'C:\boards\reference-board.cad'
pnpm qa:browser
pnpm qa:electron
pnpm package:dir
pnpm qa:packaged
```

The performance workload expects `AC1` on the bottom side with a `GND` pin, and `GND` pads on both sides. Keep the same board and browser for a before/after comparison:

```powershell
pnpm qa:performance --label=before
# Apply the renderer change, then run the same workload again.
pnpm qa:performance --label=after
```

`before` is the default label and writes `test-results/performance-before.json`. The `after` run reads that baseline, checks that board/net counts are preserved and checks zoom timing for regressions. For a separate diagnostic run, `pnpm qa:performance --label=diagnostic --profile-zoom` also saves a Chromium CPU profile of the top-side GND zoom workload. Callback timings, frame gaps and forced canvas readback timings are reported separately.

`TRACE_QA_URL` sets the Vite URL for browser, race, renderer, localization browser and performance checks. They default to the local server on port 5173 (`localhost`, or `127.0.0.1` for renderer checks). `TRACE_BROWSER_CHANNEL=msedge` uses an installed Edge browser. `TRACE_EXPECT_COUNTS` can specify expected `components,pins,nets` counts for real-board UI and performance checks. Normal QA uses the project's declared Playwright dependency; the renderer harness additionally accepts `TRACE_PLAYWRIGHT_PATH` as an advanced fallback for environments that require an alternate installed Playwright module. QA output and isolated profiles stay under the ignored `test-results/` directory.

## Share and contribute

See [CONTRIBUTING.md](CONTRIBUTING.md) for code, translation and format contributions, and [RELEASING.md](RELEASING.md) for the release builds and the draft-release workflow. GitHub Actions tests and builds the application without any private board data. Release binaries belong in GitHub Releases rather than in Git history.

If TRACE saves you time, a GitHub star helps other technicians find it.

TRACE's original code and artwork use the [MIT license](LICENSE). Bundled dependencies and fonts retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
