import type { WindowCounters } from './counters.js';

export interface BudgetConfig {
  /** AI: Вызовов модели на устройство гостя в час / сутки; 0 - гостю модель не даётся вовсе. */
  guestPerHour: number;
  guestPerDay: number;
  /** AI: Вызовов модели на IP в час, только гости (общежитие за одним NAT - лимит выше). */
  guestIpPerHour: number;
  /** AI: Потолок токенов (вход + выход) за сутки на всех; 0 - без потолка. */
  dailyTokenBudget: number;
}

export type BudgetStage = 'ok' | 'guests_off' | 'all_off';

export interface BudgetSnapshot {
  stage: BudgetStage;
  tokensToday: number;
  dailyTokenBudget: number;
  /** AI: Доля потолка, 0..1+; null - потолка нет. */
  usedShare: number | null;
}

export interface GuestKey {
  device?: string;
  ip?: string;
}

const HOUR = 3_600_000;
const DAY = 86_400_000;
/** AI: Гости отключаются на 80 % потолка, все - на 100 %. */
const GUEST_CUTOFF = 0.8;
const STAGE_TTL_MS = 60_000;

/**
 * AI: Бюджет модели. Две независимые защиты:
 *  1. гость (аноним) получает модель только в рамках небольшого бюджета на устройство и IP;
 *  2. общий суточный потолок токенов: при 80 % гости переводятся на базу знаний, при 100 % - все.
 * Превышение никогда не даёт ошибку - движок отвечает по базе знаний без модели.
 * Счётчики общие для реплик (таблица rate_limits); ступень потолка кэшируется на минуту.
 */
export class LlmBudget {
  private stageCache: { at: number; snap: BudgetSnapshot } | null = null;

  constructor(
    private readonly counters: WindowCounters,
    private readonly cfg: BudgetConfig,
    private readonly log: { warn(obj: unknown, msg?: string): void } = { warn() {} },
  ) {}

  /** AI: Можно ли этому запросу звать модель. `guest` - ключи гостя; для полноправных - undefined. */
  async allows(scope: 'guest' | 'full', guest?: GuestKey): Promise<boolean> {
    const stage = (await this.snapshot()).stage;
    if (stage === 'all_off') return false;
    if (scope !== 'guest') return true;
    if (stage === 'guests_off') return false;
    if (this.cfg.guestPerHour <= 0 || this.cfg.guestPerDay <= 0) return false;
    const keys = this.guestKeys(guest);
    if (!keys.length) return true;
    const counts = await this.counters.peekMany(keys.map((k) => k.key));
    return keys.every((k) => (counts.get(k.key) ?? 0) < k.limit);
  }

  /** AI: Учесть вызов модели гостем (после того, как allows() разрешил). */
  async noteGuestCall(guest?: GuestKey): Promise<void> {
    await Promise.all(this.guestKeys(guest).map((k) => this.counters.bump(k.key, k.windowMs)));
  }

  /** AI: Учесть расход токенов (вызывается из onUsage модели). */
  async noteTokens(n: number): Promise<void> {
    if (n <= 0) return;
    await this.counters.bump(this.tokensKey(), DAY, n);
    // AI: Крупный вызов может перевести ступень - обновим кэш при следующем запросе.
    this.stageCache = null;
  }

  async snapshot(): Promise<BudgetSnapshot> {
    const now = Date.now();
    if (this.stageCache && now - this.stageCache.at < STAGE_TTL_MS) return this.stageCache.snap;
    const budget = this.cfg.dailyTokenBudget;
    const tokensToday = budget > 0 ? await this.counters.peek(this.tokensKey()) : 0;
    const usedShare = budget > 0 ? tokensToday / budget : null;
    const stage: BudgetStage =
      usedShare === null
        ? 'ok'
        : usedShare >= 1
          ? 'all_off'
          : usedShare >= GUEST_CUTOFF
            ? 'guests_off'
            : 'ok';
    const snap = { stage, tokensToday, dailyTokenBudget: budget, usedShare };
    if (this.stageCache && this.stageCache.snap.stage !== stage)
      this.log.warn({ stage, tokensToday, budget }, 'llm budget stage changed');
    this.stageCache = { at: now, snap };
    return snap;
  }

  private guestKeys(guest?: GuestKey): Array<{ key: string; limit: number; windowMs: number }> {
    const out: Array<{ key: string; limit: number; windowMs: number }> = [];
    if (guest?.device) {
      out.push({ key: `llm:dev:${guest.device}:h`, limit: this.cfg.guestPerHour, windowMs: HOUR });
      out.push({ key: `llm:dev:${guest.device}:d`, limit: this.cfg.guestPerDay, windowMs: DAY });
    }
    if (guest?.ip && this.cfg.guestIpPerHour > 0)
      out.push({ key: `llm:ip:${guest.ip}:h`, limit: this.cfg.guestIpPerHour, windowMs: HOUR });
    return out;
  }

  /** AI: Ключ суток по UTC - совпадает с днём в daily_stats. */
  private tokensKey(): string {
    return `llm:tokens:${new Date().toISOString().slice(0, 10)}`;
  }
}
