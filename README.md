# Shufflebord

Et hybrid bordspill: storskjermen er bordet, og mobilene er kontrollere. Skjermen
kan ligge flatt med ekte glass oppå, som puckene spretter av.

## Kom i gang

```
npm install
npm start
```

Åpne `http://localhost:3000` på maskinen som styrer storskjermen, og skann QR-koden
med mobilene. Mobilene må være på samme nettverk.

Storskjermer på andre maskiner kan vise spillet uten videre. For å styre det må
du taste verts-PIN-en under **Oppsett**. Den står i serverens konsoll.

| Variabel | Bruk |
|---|---|
| `PORT` | Port, standard 3000 |
| `HOST_PIN` | Fast verts-PIN i stedet for den genererte |
| `PUBLIC_URL` | Adressen QR-koden skal peke til, for eksempel bak en proxy |
| `DATA_DIR` | Hvor oppsett og æresplass lagres, standard `data/` |

## Hindringer under ekte glass

Velg **Oppsett → Rediger hindringer**. Klikk for å lage en, dra for å flytte,
scroll for størrelse og dobbeltklikk for å slette. Oppsettet lagres automatisk.
Bruk fullskjerm før du plasserer dem, og behold samme skjermstørrelse når dere spiller.

## Kode

- `public/physics.js`: fysikken, felles for server og storskjerm
- `game.js`: regler og tilstand, uten nettverkskode
- `server.js`: HTTP, sockets, tilgangskontroll og lagring
- `public/board.js`: storskjermen
- `public/mobile.js`: kontrolleren

Serveren regner ut hvert kast. Storskjermen kjører samme simulering for å animere det.

Testene kjøres med `npm test`.
