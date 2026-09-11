import { Icon } from '../components/Icon';
import type { ThemeMode } from '../lib/theme';

/**
 * AI: Публичный лендинг сайта. Показывается в обычном браузере до входа; внутри мессенджера
 * приложение сразу открывает чат.
 */
export function LandingScreen(props: {
  sphere: string;
  botUrl?: string;
  theme: ThemeMode;
  onToggleTheme: () => void;
  onStart: () => void;
}) {
  const themeIcon = props.theme === 'light' ? 'sun' : props.theme === 'dark' ? 'moon' : 'auto';
  return (
    <div className="landing">
      <div className="brandline">
        <span className="brand">
          <Icon name="bot" size={20} />
        </span>
        <div style={{ flex: 1, fontWeight: 700 }}>Помоги мне</div>
        <button className="icon-btn" onClick={props.onToggleTheme} aria-label="Переключить тему">
          <Icon name={themeIcon} size={18} />
        </button>
      </div>

      <section className="hero">
        <div className="eyebrow">{props.sphere || 'Виртуальная поддержка'}</div>
        <h1>Помощник поддержки, который решает, а не переспрашивает</h1>
        <p>
          Опишите проблему своими словами. Помощник определит, к чему она относится, задаст только
          нужные уточнения и даст пошаговое решение из базы знаний. Если решить самостоятельно
          нельзя, по вашему согласию создаст заявку специалисту.
        </p>
        <div className="cta">
          <button className="btn" onClick={props.onStart}>
            Начать в браузере
          </button>
          {props.botUrl && (
            <a
              className="btn secondary"
              href={props.botUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Открыть в Telegram
            </a>
          )}
        </div>
      </section>

      <section className="features">
        <div>
          <h3>Понимает с первого сообщения</h3>
          <p>Категория, суть проблемы и уже названные детали извлекаются автоматически.</p>
        </div>
        <div>
          <h3>Только нужные вопросы</h3>
          <p>Не больше двух уточнений, и только те, без которых решение не подобрать.</p>
        </div>
        <div>
          <h3>Ответы из проверенной базы</h3>
          <p>Шаги берутся из базы знаний организации; помощник не выдумывает.</p>
        </div>
        <div>
          <h3>Специалист только по вашему решению</h3>
          <p>Заявка создаётся только с согласия, со всей собранной информацией.</p>
        </div>
      </section>

      <footer className="foot">
        Работает в Telegram, в браузере и готов к подключению VK и MAX. Один каталог знаний, любая
        сфера.
      </footer>
    </div>
  );
}
