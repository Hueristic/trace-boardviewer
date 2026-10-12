# Natív macOS open-file ellenőrzés (TB-130 / TB-311)

A `scripts/mac-open-file-check.cjs` a macOS-os nyitási útvonalakat méri egy telepített TRACE Boardvieweren: dupla kattintás a Finderben,
Dock-ra húzás, `open -a`, nyitás futó alkalmazásba, nyitás indulás közben, és nyitás ablak nélkül (Dock-ról újranyitás). Minden
forgatókönyvnél rögzíti, mennyi idő alatt lesz látható az ablak, és +1 s, +5 s, +10 s után képernyőképet készít. A tesztelő minden
képernyőképnél megadja, látszik-e az értesítés.

Nem Windowson futtatandó (a `--self-test` kivételével): a Windows-os eredmény nem natív macOS-eredmény.

## Előkészítés
- macOS 13 vagy újabb, a TRACE Boardviewer telepítve (a csomag, amit a Mac-tesztelő tesztel: ugyanaz a commit, mint a Windows-on).
- A Terminal (vagy az iTerm) kapjon Akadálymentesítés (Accessibility) jogot, a System Events ablakállapothoz; a képernyőképhez Képernyőfelvétel jogot.
- Az alkalmazás ne fusson, amikor a szkript indul (különben az adott forgatókönyv kimarad).
- Csak a szkript által generált mintákat használja: a szkript a repó `tests/fixtures/cst/make-cst-02.cjs` szerkezetéből építi őket, privát mintafájl nincs bennük.

## Futtatás
Először ellenőrzés bárhol (csak a minták és a terv):

```bash
node scripts/mac-open-file-check.cjs --self-test --out /tmp/trace-open-check
```

Macen a teljes futás (a mintákat és a jelentést a `--out` mappába írja, alapértelmezés: az asztalon):

```bash
node scripts/mac-open-file-check.cjs --app "/Applications/TRACE Boardviewer.app" --out ~/Desktop/trace-open-check
```

Csak néhány forgatókönyv: `--only S1,S4`. A kézi forgatókönyvek (S7 Dock-húzás, S8 Finder-dupla kattintás) megkérik a műveletre,
majd Entert kérnek, amikor kész.

## Mit kell visszaküldeni
- `report.md` (a táblázat) és `report.json`.
- A `shots/` mappa képernyőképei (a kérdéses forgatókönyvekből legalább S1, S3, S5, S6).
- Egy sor: melyik forgatókönyvnél nem látszott az értesítés, és mennyi idő után lett látható az ablak.

## Mit nem fed le
- A kézi műveletek időpontja Enterrel jelölt: a Dock-húzás és a dupla kattintás tényleges ideje ettől néhány száz ms eltérhet.
- A szkript nem olvassa ki az értesítés szövegét (a képernyőképet és a tesztelő válaszát használja).
- Nincs csomagolt (notarizált) aláírt build ellenőrzés; a telepített alkalmazást méri.
