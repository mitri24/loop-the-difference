# UI-Redesign · Loop the Difference

Stand: 14. November 2026. Lokale Anwendung: http://localhost:8080.
Angewendete Grundlage: der vom Nutzer bereitgestellte Skill `planet-x-senior-ux` aus `Downloads/planet-x-senior-ux-skill.zip`.

## 1. Änderungen und Entwurfsentscheidungen

Aladin bleibt eine interaktive Karte über die gesamte Bildschirmfläche. Eine kompakte Kopfzeile bündelt Objektsuche, Locate, Compare, Data, Share und About. Genau ein schließbarer Arbeitscontainer ist geöffnet; Kartenbedienung und Aladin-Logo erhalten eigene freie Bereiche. Native Kartenmenüs schließen den App-Container beim Öffnen. Geschlossene Container erhalten Eingaben, Vergleich und Bildauswahl.

Die tatsächlich gemessene Kopfzeilenhöhe steuert die Abstände der Karte und ihrer Werkzeuge. Auf sehr kurzen Fenstern und bei starkem Zoom wird die Oberfläche zu einem scrollbareren Dokument. Normale Desktopfenster benötigen keinen Seiten-Scroll. Formulare und Datensätze scrollen innerhalb des Containers; die primären Positionsaktionen bleiben außerhalb dieses Scrollbereichs sichtbar.

Die Oberfläche verwendet dunkle neutrale Flächen, einen zurückhaltenden grünen Akzent, klar beschriftete Aktionen und keine Glasflächen oder dekorativen Astronomiebilder. Auf dem Handy sind zusätzliche Bereiche schließbar. Blink beginnt pausiert; seine Tastenkürzel gelten innerhalb des Players. Die Karte besitzt eigene Tastatursteuerung mit Pfeilen sowie Plus/Minus.

Wichtige Dateien:

- `src/App.tsx`: Arbeitsfläche, Bereiche, Suche, Anfragesteuerung, Abbruch, Wiederholen, Teilen, Kartenmitte, Status und Belege.
- `src/styles.css`: visuelles System, Karten-Sicherheitsbereiche, Container, Reflow und Fokus.
- `src/components/TargetForm.tsx`: Beispiele, präzise Koordinaten und gemeinsame Detektor-/Regionsauswahl für alle Suchwege.
- `src/components/SkyView.tsx`: bestehender Aladin-Adapter, tatsächlicher AllWISE-Fallback, korrekte Ladebeschriftung und Teilen der aktuellen Kartenposition.
- `src/components/BlinkPlayer.tsx`, `DifferenceView.tsx`, `ObservationImage.tsx`: Bildvergleich, pausierter Start und Wiederholen fehlgeschlagener Bilder.
- `src/api.ts`: bestehende API-Verträge, Abbruchsignale, Zeitlimit und verständlicher Netzwerkfehler.

### Forschung und Informationsarchitektur

Arbeitsannahmen, keine beobachteten Forschungsergebnisse: Neugierige Einsteiger brauchen Beispiele und eine klare nächste Aktion; Studierende benötigen Zeitvergleich und Quellen; erfahrene Nutzer benötigen genaue Koordinaten und native Kartenwerkzeuge. Der primäre Job lautet: „Eine Region finden, echte Bilder verschiedener Zeiten betrachten und die Grenzen des Vergleichs prüfen.“

Vorher: gleichzeitige permanente Such- und Vergleichskarten, lange Erklärung, überdeckte native Werkzeuge und doppelte Teilaktionen. Nachher: eine Suchleiste, eine Karte und ein bedarfsabhängiger Bereich. Dauerhaft sichtbar sind Suche, Bereichswahl und der Kontext-Layer. Beobachtungsdaten und Warnungen sind kontextuell; ausführliche Quellen und Anleitungen stehen unter Data/About.

Nicht durch eine Nutzerstudie geklärt: Auffindbarkeit von Compare ohne Hilfestellung, Verständnis von Detektor versus Kartenlayer, Bearbeitungszeit, Erfolgsrate und Bedienung mit realer Bildschirmtastatur. Es wurden keine Teilnehmer oder Erfolgsstatistiken erfunden. Eine sinnvolle Folgestudie umfasst unangeleitete Aufgaben mit Einsteigern und mindestens einem technisch erfahrenen Nutzer. Eine spätere, bewusst freigegebene Messung könnte Suchversuche, geladene Beobachtungen, Vergleichsstarts, Wiedergabe, Quellenaufrufe und Fehlerbehebung zählen; es wurde kein Tracking installiert.

## 2. Geprüfter Nutzerablauf

**Echte Daten:** Den bereitgestellten Polaris-Link öffnen → zwei vorbereitete Epochen laden → Qualitätsbedingte Sperre der Differenz erkennen → Stacks wählen → Play → Pause → nächstes Bild → Data mit Release und Abdeckung öffnen → Container schließen → nativen Vollbildmodus öffnen und verlassen → Vergleich bei 390 × 844 wieder öffnen. Zusätzlich wurden echte Namensauflösung, Queue-Zustand und ungültige Koordinaten direkt über den laufenden Proxy geprüft.

**Vertragstests mit synthetischen Testdaten:** Objektnamen eingeben → Eingabetaste → `/api/resolve` → `/api/observations` und `POST /api/frames` → gegebenenfalls Job abfragen → Bilder/Quellen anzeigen. Ein geänderter Detektor wird sowohl von der Objektsuche als auch von Koordinaten und Beispielen übernommen. Kartenbewegung per Tastatur → „Use map center & compare“ sendet die neue Kartenmitte. Differenzpaar-Auswahl und Legende werden mit kompatiblen Testdaten geprüft. Testdaten werden ausschließlich durch Playwright-Routen bereitgestellt und sind nicht Teil der Anwendung.

## 3. Feature-Parität und Anbindungen

| Vorhandene Funktion | Neue Platzierung / Anbindung | Nachweis |
| --- | --- | --- |
| Namenssuche über Sesame/Gaia-Backend | Suche in Kopfzeile → `GET /api/resolve` | Echter Polaris-Resolver + UI-Vertragstest, unbekannter Name als Fehlerfall |
| Koordinaten und Beispiele | Locate → bestehende serverseitige Koordinatenparser | Echte 422-Antwort + Formular-/Beispieltests |
| Detektor und Region | Locate, gemeinsame Parameter für alle Suchwege | POST-Parameter, Detektorwechsel, URL und Reload geprüft |
| Beobachtungsübersicht | Data → `GET /api/observations` | Echte Polaris-Epochen + Fehlertests |
| Bildaufbereitung | `POST /api/frames` → Redis/RQ wie bisher | Echter fertiger Job; synthetische Queue-/Ausfalltests |
| Fortschritt / Polling | Compare → `GET /api/frames/{job_id}` | Queue→Polling→fertig als Vertragstest |
| PNG-Bilder | `GET /api/frames/{job_id}/{filename}` | Echte PNGs mit Bildbreite > 1; Fehler und Retry getestet |
| Blink, Schritt, Geschwindigkeit, Scrubber | Compare | UI-/Tastaturtests; reale Wiedergabe und Bildschritt |
| Exposures / Stacks | Compare, bestehendes Stack-Flag | POST-Vertrag und Umschaltung geprüft |
| Differenz und A/B-Auswahl | Compare, vorhandene Differenzprodukte | Kompatible Testdaten; echte Polaris-Sperre bleibt wirksam |
| Qualitätsbelege und Provenienz | Compare → Quality checks; Data; Bildmetadaten | Beobachtungs-IDs, URLs, Zeiten und Release erhalten |
| Pan / Zoom / Fadenkreuz / Footprint | Native Aladin-Karte; zusätzliche Tastatursteuerung | Canvas, Kartenmitte-Request, native Werkzeugprüfung |
| Layer, Grid, Einstellungen, Simbad-Pointer, Share | Vorhandene native Aladin-Menüs | Menüs und Schalter im Browser geöffnet; Screenshots |
| Projektions- und Koordinatenkontrollen | Native Aladin-Kontrollen unter der Kopfzeile | Sichtbarkeit/Erreichbarkeit im Layout; nicht jede einzelne Einstellung fachlich abgenommen |
| Vollbild und Resize | Native Kontrolle und Aladin-ResizeObserver | Echter Vollbildwechsel; 40 Größenkombinationen |
| Teilen / Embed | Share für Vergleich; natives Share für Kartenposition; `embed=1` | Clipboard, URL-Modus und Embed-Player geprüft |
| About / Credits | About-Dialog | Öffnen, Escape und Fokusverhalten geprüft |
| Backend / Middleware | Vorhandener nginx-Proxy `/api` → FastAPI → Redis/RQ | Live Health, Resolver, Validierung, Bildjob und echte Bilddateien |

Für die neue Oberfläche werden keine zusätzlichen Server-Endpunkte vorausgesetzt. „Stop waiting“ beendet die clientseitigen Anfragen und Abfragen; es behauptet nicht, einen bereits gestarteten RQ-Job serverseitig abzubrechen. HTTP-Anfragen haben ein Zeitlimit, ersetzte Anfragen werden abgebrochen und alte Ergebnisse überschreiben keine neuere Suche. Das Backend kann weiterhin seinen Cache füllen.

## 4. Responsive- und Accessibility-QA

| Prüfung | Ergebnis |
| --- | --- |
| Breiten 320, 375, 390, 600, 768, 1024, 1280, 1366, 1440, 1920 × Höhen 600, 700, 768, 900 | 40 Kombinationen geprüft: kein horizontaler Seitenüberlauf; normale Arbeitsfläche ohne vertikalen Seiten-Scroll; Container/Schließen/primäre Aktion erreichbar |
| Aladin-Logo, Werkzeugleiste, Vollbild | Innerhalb des Fensters; Mittelpunkt-Hit-Test ohne abfangende App-Container |
| 200%-/400%-Reflow-Äquivalente von 1440 × 900 | 720 × 450 und 360 × 225: scrollbares Reflow, primäre Aktion und Schließen erreichbar; kein horizontaler Seitenüberlauf |
| Touch und Rotation | Emulierter Touch bei 375 × 667, danach 667 × 375; Bereichswahl und Vergleich bedienbar |
| Tastatur | Such-Eingabetaste, Bereichsfokus, Escape/Fokusrückgabe, About, Bildschritt und Kartensteuerung |
| Reduzierte Bewegung | Medienpräferenz emuliert; Wiedergabe beginnt pausiert |
| Fehlende Daten / API / Bild / WebGL2 | Fehlerzustände, Wiederholen, Alternativregion und nutzbarer Player geprüft |

Die Reflow-Prüfung nutzt verkleinerte CSS-Viewports; echte Browser-Menü-Zoomstufen wurden nicht separat bedient. Touch wurde emuliert. Ein echtes iPhone/Android-Gerät, Bildschirmtastatur, Screenreader und die komplette fachliche Bedienung aller nativen Aladin-Untermenüs wurden nicht geprüft. Dies ist keine vollständige WCAG-Zertifizierung.

Screenshots befinden sich in `screenshots/`: echte Polaris-Bilder und Daten, mobile Ansicht, native Ebenen und Reflow. PNGs zeigen jeweils einen konkreten Zeitpunkt; externe Survey-Kacheln können beim Öffnen noch laden.

## 5. Wissenschaftliche Provenienz und Grenzen

Die laufende API meldet `spherex_dr1`. Der geprüfte Polaris-Job liefert zwei vollständige Epochen-Stacks auf einem Raster mit 6,15 Bogensekunden pro Pixel:

| Zeitpunkt des Referenzbilds (UTC) | Beobachtung | Abdeckung |
| --- | --- | --- |
| 2025-09-20 20:25:52 | `2025W38_2C_0463_1` | 99,4 % |
| 2026-02-15 09:59:36 | `2026W07_2A_0542_1` | 99,1 % |

**Eine wissenschaftlich zulässige echte Polaris-Differenz wurde nicht nachgewiesen:** Das Backend liefert `WAVELENGTH_MISMATCH` als Blocker. Die effektive Wellenlänge liegt zwischen 4,615 und 4,702 µm, eine Abweichung von 1,9 % gegenüber einem Auflösungselement von etwa 0,8 % für D6. Daneben liegen Warnungen über markierte Pixel am Ziel vor. Das Redesign übernimmt diese Sperre und zeigt Epochen-Stacks mit Warnungen. Erfolgreiche Differenzpaar-Bedienung wurde ausschließlich mit synthetischen kompatiblen Testdaten geprüft.

Der Aladin-Survey ist ausdrücklich Kontext. Ein Wechsel zu AllWISE ist kein Wechsel der Vergleichsbeobachtungen. Quellen, Datumswerte, Detektor, Wellenlängen, Abdeckung und Beobachtungs-IDs bleiben erhalten. Es gibt keine erfundenen Entdeckungen, Katalogtreffer oder Bewegungsbewertungen. Andere Ziele und Datenfreigaben wurden nicht umfassend fachlich validiert.

Geprüfte offizielle Referenzen: [Aladin-API](https://cds-astro.github.io/aladin-lite/Aladin.html), [IRSA SPHEREx](https://irsa.ipac.caltech.edu/Missions/spherex.html). Die tatsächliche Datenfreigabe im UI stammt aus der API/Manifest-Antwort.

## 6. Qualität, Reproduktion und verbleibende Punkte

Aus `frontend/`, bei laufendem Docker-Stack:

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Die Browserprüfungen benutzen vorhandenes Chrome auf macOS oder den Playwright-Chromium-Standard. Optional können `CHROME_PATH` und `SKYSHIFT_BASE_URL` gesetzt werden. Auf Systemen ohne Browser zunächst `npx playwright install chromium` ausführen. Live-Tests benötigen das laufende Backend und gegebenenfalls Internetzugang. `playwright-report/index.html` enthält den Browserbericht; `test-results/` enthält Screenshots und bei Fehlern Traces.

Prüfstand: Build, Lint, TypeScript und 25 Unit-Tests bestanden. Browserprüfung: alle 28 Tests inklusive Live-, Layout-, Vertrags-, Touch-, Reflow- und WebGL-Ausfallprüfungen bestanden (Gesamtlauf: 59,5 Sekunden).

Keine bekannte P0/P1-Regression in den geprüften Abläufen. Vor einer fachlichen Freigabe bleiben die oben genannten wissenschaftlichen Datenblocker sowie echte Nutzer-, Geräte- und Screenreader-Prüfungen offen. Individuelle Frame-/Epochenauswahl und Kartenlayer werden nicht zusätzlich in der App-URL gespeichert; geteilt werden wie bisher Region, Größe, Detektor und Modus. Die Benutzeroberfläche behauptet keine vollständige Reproduzierbarkeit einer manuell ausgewählten Bildfolge.

## Screenshot-Nachweise

- [Desktop-Vergleich mit echten Bildern](screenshots/desktop-comparison.png)
- [Mobile Ansicht mit echten Bildern](screenshots/mobile-comparison.png)
- [Beobachtungsdaten und Provenienz](screenshots/desktop-data.png)
- [Native Aladin-Ebenen](screenshots/native-layers.png)
- [320-Pixel-Ansicht](screenshots/narrow-320.png)
- [400%-Reflow-Äquivalent](screenshots/zoom-reflow-400-equivalent.png)
- [Tatsächliche API-Antworten](live-api.json) und [Bildmanifest](real-manifests.json)
