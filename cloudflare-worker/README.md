# Zapfy Google-Maps-Kurzlink-Resolver (Cloudflare Worker)

Kleiner, dauerhaft kostenloser CORS-Resolver (Cloudflare Free Tier: 100.000 Anfragen/Tag gratis), damit auch nackte Google-Maps-Kurzlinks (`https://maps.app.goo.gl/...`) direkt in Zapfy (iOS & Android) aufgelöst werden.

## Einrichtung in 30 Sekunden (ohne lokale Tools)

1. Kostenloses Konto unter [dash.cloudflare.com](https://dash.cloudflare.com/) öffnen → links auf **Compute (Workers) → Workers & Pages → Create → Create Worker** klicken.
2. Namen vergeben (z. B. `zapfy-maps-resolver`) → **Deploy** klicken → danach oben auf **Edit code** klicken.
3. Den kompletten Inhalt aus [`maps-resolver.js`](maps-resolver.js) einfügen und rechts oben auf **Deploy** klicken.
4. Die angezeigte Worker-URL (z. B. `https://zapfy-maps-resolver.<dein-name>.workers.dev`) kopieren und in Zapfy im Tab **Setup → Maps-Kurzlink-Resolver (Optional)** speichern.

## Sicherheit
- Der Worker akzeptiert ausschließlich `https://maps.app.goo.gl/...` und `https://goo.gl/maps/...` und folgt Weiterleitungen nur innerhalb offizieller Google-Domains.
- Optional kannst du im Cloudflare-Dashboard unter **Settings → Variables** die Variable `ALLOWED_ORIGIN` auf `https://line1982.github.io` setzen.
