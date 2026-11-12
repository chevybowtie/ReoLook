// Motion detection layout as the camera reports it: a grid of watched cells and sensitivity
// windows. Parsing never invents data: anything that does not fit is reported, not repaired.

const hhmm = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
/** Whether a value is a whole number within the range. */
const isInt = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;

/**
 * The device's time windows as `{id, from, to, sensitivity}` (plus `enabled` and `priority` when `withEnable`); an unusable list gives none.
 */
function windowsOf(list, { withEnable = false } = {}) {
  if (!Array.isArray(list)) return [];
  return list.map((w) => ({
    id: w.id ?? null,
    from: hhmm(w.beginHour ?? 0, w.beginMin ?? 0),
    to: hhmm(w.endHour ?? 0, w.endMin ?? 0),
    sensitivity: Number.isFinite(w.sensitivity) ? w.sensitivity : null,
    ...(withEnable ? { enabled: w.enable === 1 || w.enable === true, priority: w.priority ?? null } : {}),
  }));
}

/**
 * @param alarm   value.Alarm from GetAlarm {Alarm:{channel,type:"md"}}
 * @param mdAlarm value.MdAlarm from GetMdAlarm (optional)
 * @returns {{ grid: object|null, problem: string|null, sensitivity: object, raw: object }}
 */
export function parseMotion(alarm, mdAlarm = null) {
  const scope = alarm?.scope ?? mdAlarm?.scope ?? null;
  let grid = null, problem = null;
  if (!scope) problem = 'the device did not report a detection area';
  else if (!isInt(scope.cols, 1, 512) || !isInt(scope.rows, 1, 512)) problem = `unusable grid size (${scope.cols} x ${scope.rows})`;
  else if (typeof scope.table !== 'string') problem = 'the detection area is not a string of cells';
  else if (scope.table.length !== scope.cols * scope.rows) problem = `the area has ${scope.table.length} cells but a ${scope.cols} x ${scope.rows} grid needs ${scope.cols * scope.rows}`;
  else if (/[^01]/.test(scope.table)) problem = 'the area contains values other than 0 and 1';
  else {
    const active = [...scope.table].filter((c) => c === '1').length;
    grid = { cols: scope.cols, rows: scope.rows, table: scope.table, activeCells: active, totalCells: scope.table.length,
      coveragePercent: Math.round((active / scope.table.length) * 1000) / 10 };
  }
  // if both commands carry a table and they differ, say so rather than choosing silently
  const other = mdAlarm?.scope?.table;
  const tablesAgree = typeof other === 'string' && typeof scope?.table === 'string' ? other === scope.table : null;

  const legacy = windowsOf(alarm?.sens ?? mdAlarm?.sens);
  const next = mdAlarm?.newSens ? windowsOf(mdAlarm.newSens.sens, { withEnable: true }) : [];
  const sensitivity = {
    windows: legacy,
    newStructure: mdAlarm?.newSens ? { inUse: mdAlarm.useNewSens === 1 || mdAlarm.useNewSens === true, defaultSensitivity: mdAlarm.newSens.sensDef ?? null, windows: next } : null,
    // the one number worth showing, only when every source agrees
    summary: (() => {
      const vals = new Set(legacy.map((w) => w.sensitivity).filter((v) => v !== null));
      const nd = mdAlarm?.newSens?.sensDef;
      if (vals.size === 1 && (nd === undefined || nd === [...vals][0])) return { value: [...vals][0], uniform: true };
      return { value: null, uniform: false };
    })(),
  };
  return { grid, problem, tablesAgree, sensitivity, raw: { enableField: alarm?.enable ?? null, channel: alarm?.channel ?? null } };
}
