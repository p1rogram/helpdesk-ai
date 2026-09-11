import { z } from 'zod';

/**
 * AI: Каталог = «сфера» помощника. Сменить сферу (IT-поддержка -> университет -> провайдер) значит
 * подменить JSON-файл, удовлетворяющий этой схеме. Без правок кода.
 */
export const ExtractRuleSchema = z.object({
  /** AI: Регулярка по сообщению в нижнем регистре; значение - первая непустая группа захвата. */
  pattern: z.string().min(1),
  /** AI: Как оформить захваченное значение, `$1` = захват. По умолчанию - сам захват. */
  format: z.string().optional(),
  /**
   * AI: Белый список захваченных значений, которые реально существуют. Всё остальное отклоняется.
   */
  allow: z.array(z.string()).optional(),
  /** AI: Показывается, когда значения нет в `allow`; `{value}` заменяется на захваченное. */
  reject: z.string().optional(),
});
export type ExtractRule = z.infer<typeof ExtractRuleSchema>;

export const ClarifyingFieldSchema = z.object({
  id: z.string().min(1),
  /** AI: Человеческая подпись для карточки тикета («Срочность», а не «urgency»). */
  label: z.string().min(1).optional(),
  /**
   * AI: Вопрос, который видит пользователь, когда поле не заполнено. Детерминированный - без затрат
   * на модель.
   */
  question: z.string().min(1),
  /** AI: Необязательные варианты быстрого ответа, рендерятся кнопками. */
  options: z.array(z.string()).optional(),
  /** AI: Спрашивать, только если поле нужно, чтобы подобрать / адаптировать решение. */
  required: z.boolean().default(true),
  /**
   * AI: Условно обязательное: спрашивается, только когда значение другого поля подходит под шаблон
   * («комната» нужна для общежития, а не для учебного корпуса). Проверяется после `required`.
   */
  requiredWhen: z.object({ field: z.string().min(1), pattern: z.string().min(1) }).optional(),
  /**
   * AI: Детерминированные правила извлечения. Позволяют движку вытащить значение прямо из текста
   * пользователя (номер общежития, комната, корпус), не полагаясь на модель, и отклонить значения,
   * которых в организации нет. Несколько правил = несколько форм одного места («общежитие 12»,
   * «корпус 8»); решает первое правило, чей шаблон совпал. Живут в каталоге - то есть в базе, - а
   * не в коде.
   */
  extract: z.union([ExtractRuleSchema, z.array(ExtractRuleSchema).min(1)]).optional(),
});

export const KbArticleSchema = z.object({
  id: z.string().min(1),
  categoryId: z.string().min(1),
  title: z.string().min(1),
  /** AI: Симптомы свободным текстом - для поиска. */
  symptoms: z.string().min(1),
  /** AI: Упорядоченные шаги. Показываются дословно в режиме без модели. */
  steps: z.array(z.string().min(1)).min(1),
  /** AI: Условия, при которых статья не подходит - помогает модели не гадать. */
  notApplicableWhen: z.string().optional(),
  /**
   * AI: Если true - до конца решить может только человек; помощник делает что может и передаёт.
   */
  escalateAfter: z.boolean().default(false),
  /**
   * AI: 'public' статьи видны гостям (поступление, контакты, адреса); остальные требуют входа
   * организации.
   */
  audience: z.enum(['public', 'internal']).default('internal'),
  /** AI: Откуда статья (ссылка показывается пользователю в поиске по базе знаний). */
  source: z.string().url().optional(),
});

export const CategorySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  /** AI: Поля, которые движок спрашивает до поиска решения. */
  clarify: z.array(ClarifyingFieldSchema).default([]),
  /** AI: Приоритет по умолчанию для тикетов этой категории. */
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
});

export const CatalogSchema = z.object({
  /** AI: Id тенанта. Одна установка обслуживает много тенантов (сфер) бок о бок. */
  id: z.string().regex(/^[a-z0-9-]{2,32}$/, 'tenant id: lowercase letters, digits, dashes'),
  sphere: z.string().min(1),
  /** AI: Короткое описание организации - попадает в системный промпт. */
  organisation: z.string().min(1),
  language: z.string().default('ru'),
  categories: z.array(CategorySchema).min(1),
  articles: z.array(KbArticleSchema).min(1),
});

export type ClarifyingField = z.infer<typeof ClarifyingFieldSchema>;
export type KbArticle = z.infer<typeof KbArticleSchema>;
export type Category = z.infer<typeof CategorySchema>;
export type Catalog = z.infer<typeof CatalogSchema>;
