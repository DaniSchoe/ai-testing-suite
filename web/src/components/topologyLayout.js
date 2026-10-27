// Spaltenzuordnung der Topologie: Verbundene Komponenten sollen in benachbarten Ebenen untereinander stehen.
// Jede Kante führt von einem Elternteil in einer früheren Ebene zu einem Kind in einer späteren. Wir gehen die Ebenen von oben nach
// unten durch und setzen jedes Kind unter den Mittelwert seiner Eltern; belegte Spalten werden zur nächsten freien verschoben.
export function assignColumns(layers, edges) {
  const column = new Map();
  for (const ids of layers) {
    const used = new Set();
    const wanted = ids.map((id) => {
      const cols = edges.filter(([, child]) => child === id).map(([parent]) => column.get(parent)).filter((c) => c !== undefined);
      return [id, cols.length ? Math.round(cols.reduce((a, b) => a + b, 0) / cols.length) : null];
    });
    for (const [id, want] of wanted.filter(([, w]) => w !== null).sort((a, b) => a[1] - b[1])) {
      // nächste freie Spalte: want, want+1, want-1, want+2, ...
      let col = want;
      for (let d = 1; used.has(col) || col < 0; d++) col = want + (d % 2 ? (d + 1) / 2 : -d / 2);
      used.add(col);
      column.set(id, col);
    }
    for (const [id] of wanted.filter(([, w]) => w === null)) {
      let col = 0;
      while (used.has(col)) col++;
      used.add(col);
      column.set(id, col);
    }
  }
  return column;
}
