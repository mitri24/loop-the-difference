# Sidebar-Anpassung

Die schwebenden Arbeitscontainer wurden in eine gemeinsame linke Sidebar überführt. Locate, Compare und Data wechseln den Inhalt am gleichen Ort. Die Sidebar reicht von der Kopfzeile bis zum unteren Fensterrand und lässt sich über den Pfeil oder die aktive Bereichsschaltfläche schließen. Eingaben und Vergleichszustand bleiben erhalten.

Für diese Arbeitsfläche ist die Sidebar eine sinnvolle Alternative: Sie gibt Werkzeugen einen stabilen Platz, nutzt die Höhe besser und lässt mehr zusammenhängende Kartenfläche frei als wechselnde schwebende Karten. Das ist eine Entwurfsentscheidung, keine durch Nutzerforschung belegte Überlegenheit.

Aladin bleibt bildschirmfüllend. Auf Desktop verschieben sich die nativen Koordinaten-, Werkzeug- und FoV-Anzeigen neben die geöffnete Sidebar. Das Aladin-Logo bleibt frei. Unter 1024 Pixel Breite dient die Sidebar als schließbarer Drawer; zur vollen Kartenbedienung wird sie geschlossen. Bei kurzen Fenstern beziehungsweise starkem Zoom bleibt der dokumentartige Reflow erhalten.

Die API-Anbindungen und Datenverträge wurden nicht umgebaut. Echte Polaris-Bilddaten, Quellen, Warnungen, Blink, Differenzsperre, Teilen und Embed bleiben erhalten.

Prüfung: vorhandene 40 Größenkombinationen, Formular-/Vergleichsabläufe, Touch, Reflow, WebGL-Fallback und Live-Daten. Auf kleinen Bildschirmen prüft die Testsuite die nativen Kartenwerkzeuge nach Schließen des Drawers. Beim Öffnen nativer Aladin-Menüs wird die Sidebar erst im Click-Ereignis geschlossen, damit das Werkzeug während eines Klicks nicht unter dem Zeiger wegrückt.

Code: `src/App.tsx`, `src/styles.css`. Ergänzende Screenshots: `screenshots/sidebar-desktop.png` und `screenshots/sidebar-mobile.png`. Der grundlegende Integrations- und Wissenschaftsbericht steht in `REDESIGN-REPORT.md`.
