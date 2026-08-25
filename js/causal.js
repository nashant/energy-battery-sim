// Causal engine: forecaster + receding-horizon planner. The planner may only see
// current SOC, published prices, and forecast load — the causality guard test
// (test/causal.mjs) mutates the future and asserts decisions don't change.

export const FORECAST_DEFAULTS = { alpha: 0.15, lambdaFull: 0.75, rampSlots: 16, warmupDays: 14 };

export class Forecaster {
  constructor(opts = {}) {
    const o = { ...FORECAST_DEFAULTS, ...opts };
    this.alpha = o.alpha; this.lambdaFull = o.lambdaFull; this.rampSlots = o.rampSlots;
    this.profiles = { wd: null, we: null };
    this.daysSeen = { wd: 0, we: 0 };
    this.todayActual = 0; this.todayExpected = 0; this.slotsElapsed = 0;
  }
  static dayType(dateStr) {
    const d = new Date(dateStr + 'T12:00:00Z').getUTCDay();
    return (d === 0 || d === 6) ? 'we' : 'wd';
  }
  base(type, s) {
    const p = this.profiles[type] ?? this.profiles[type === 'wd' ? 'we' : 'wd'];
    return p ? (p[s] ?? 0) : 0;
  }
  ratio() {
    if (this.slotsElapsed === 0 || this.todayExpected <= 1e-9) return 1;
    const r = this.todayActual / this.todayExpected;
    const lam = this.lambdaFull * Math.min(1, this.slotsElapsed / this.rampSlots);
    return 1 + lam * (r - 1);
  }
  forecast(entries, todayDate) {
    const r = this.ratio();
    return entries.map(({ date, slotOfDay }) => {
      const b = this.base(Forecaster.dayType(date), slotOfDay);
      return date === todayDate ? b * r : b;   // regime ratio never crosses midnight
    });
  }
  settle(date, slotOfDay, actualKwh) {
    this.todayExpected += this.base(Forecaster.dayType(date), slotOfDay);
    this.todayActual += actualKwh;
    this.slotsElapsed++;
  }
  completeDay(date, actualBySlot) {
    const type = Forecaster.dayType(date);
    if (!this.profiles[type]) {
      this.profiles[type] = actualBySlot.map((v) => v ?? 0);
    } else {
      this.profiles[type] = this.profiles[type].map((v, s) => {
        const a = actualBySlot[s];
        return a === null || a === undefined ? v : this.alpha * a + (1 - this.alpha) * v;
      });
    }
    this.daysSeen[type]++;
    this.todayActual = 0; this.todayExpected = 0; this.slotsElapsed = 0;
  }
}
