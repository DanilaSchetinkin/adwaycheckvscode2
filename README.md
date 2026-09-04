# Adway Checker

Расширение для **VS Code** : проверка HTML-лендингов на требования Adway и быстрые правки прямо в редакторе.

**Автор:** [Danila Schetinkin](https://github.com/DanilaSchetinkin)  
**Репозиторий:** [adway-checker-vscode](https://github.com/DanilaSchetinkin/adway-checker-vscode)

---

## О проекте

Чекер смотрит типичные проблемы лендинга: форма заказа, jQuery, скрипты, ссылки, локальные пути (в т.ч. `url()` в CSS), внешние картинки, видео-ленды и т.д. Результаты показываются:

- в панели **Problems**;
- в боковой панели **Adway → Results**;
- во webview **«Результаты проверки Adway»** (после ручной проверки).

Из панели результатов:

- **ЛКМ** — переход к строке ошибки / предупреждения;
- **ПКМ** — команды исправления (вставить jQuery, починить форму, скачать картинку и т.д.).

Также есть автофикс (Quick Fix / лампочка), сниппеты `adway-*`, структура папок проекта, скачивание внешних изображений и **бесплатный локальный видео-плеер** (вместо Hermes / VideoJS).

---

## Установка (разработка)

Нужны Node.js и VS Code или Cursor.

```bash
git clone https://github.com/DanilaSchetinkin/adway-checker-vscode.git
cd adway-checker-vscode
npm install
npm run compile
```

1. Открыть папку проекта в VS Code
2. Нажать **F5** (запуск Extension Development Host).
3. В новом окне открыть HTML лендинга и пользоваться командами Adway.

Обновление после `git pull`:

```bash
npm install
npm run compile
```

Затем снова **F5** (при изменении `package.json` Reload Window недостаточно).

---

## Использование

1. Открыть HTML-файл лендинга.
2. Запустить проверку: **Ctrl+Alt+A** (Mac: **Cmd+Alt+A**) или ПКМ → **Adway: Проверить лендинг**.
3. Смотреть ошибки в панели справа / в Problems / в Activity Bar **Adway**.
4. Исправлять через ПКМ по пункту, Quick Fix или горячие клавиши ниже.

Контекстное меню редактора (HTML): проверка, очистка, форма, пути, сниппеты, структура проекта, видео-плеер.

Автодополнение: в HTML набрать `adway-`.

---

## Горячие клавиши

Работают в HTML-редакторе. На Mac вместо `Ctrl` — `Cmd`.

| Клавиши        | Команда                                              |
| -------------- | ---------------------------------------------------- |
| **Ctrl+Alt+A** | Проверить лендинг                                    |
| **Ctrl+Alt+C** | Почистить лендинг (target, picture, href, link→head) |
| **Ctrl+Alt+F** | Починить форму заказа                                |
| **Ctrl+Alt+P** | Исправить все локальные пути (HTML + CSS `url()`)    |
| **Ctrl+Alt+H** | Заменить все `href` у `<a>` на `#`                   |
| **Ctrl+Alt+R** | Показать панель результатов (дерево Adway)           |
| **Ctrl+Alt+L** | Вставить lazy loading                                |
| **Ctrl+Alt+V** | Вставить валидаторы                                  |
| **Ctrl+Alt+S** | Вставить все обязательные скрипты                    |
| **Ctrl+Alt+M** | Удалить HTML-комментарии                             |
| **Ctrl+Alt+D** | Скачать внешние изображения из ошибок → `images/`    |
| **Ctrl+Alt+O** | Открыть внешние изображения в браузере (Save as)     |

Панель Problems VS Code: **Ctrl+Shift+M**.

---

## Что проверяется

- `<!DOCTYPE html>`
- jQuery 3.6.0 в `<head>` (CDN cdnjs)
- Скрипты: lazy loading, прокрутка к `#oneform`, валидация
- Форма: `action="/order.php"`, `method="post"`, 6 скрытых инпутов, `required` у name/phone
- `id="oneform"` / `<span id="oneform">`, отсутствие лишнего `<base>`
- Ссылки `<a href>` (в т.ч. `#`, offer/tel/mailto)
- Атрибуты `target`, `<picture>` / `<source>`, `<link>` вне `<head>`
- Локальные пути: HTML + `url()` в CSS (`../images/…` и т.п.)
- Неподключённые / отсутствующие скрипты в `js/`
- Видео-ленды: Hermes / VideoJS / `media/` / `css/video.css` / `js/video.js`
- Внешние изображения / CSS / JS (вне whitelist)
- SID/Country (если настроен Sheets)
- Эвристика пустых / дублирующихся / неиспользуемых скриптов

---

## Полезные команды

| Команда                            | Зачем                                                                 |
| ---------------------------------- | --------------------------------------------------------------------- |
| Adway: Создать структуру проекта   | `images/`, `css/`, `js/`, `media/` (если есть видео), `other/`      |
| Adway: Проверить лендинг           | Запуск проверок + панель результатов                                  |
| Adway: Мастер правок (Compare)     | Все автофиксы по пунктам: diff → Применить / Пропустить / Стоп       |
| Adway: Установить видео-плеер      | **Бесплатный** локальный плеер: `#container_video` + `media/video.mp4` |
| Adway: Шапка / подвал по ссылке    | URL → header/footer + `css/hdr.css` / `ftr.css` → Compare              |
| Adway: Почистить лендинг           | target, picture, href, `<link>` → `<head>`                            |
| Adway: Перенести `<link>` в `<head>` | все `<link>` вне head                                               |
| Adway: Починить форму заказа       | action/method/oneform/required/hidden                                 |
| Adway: Удалить дубли (images/css/js) | одинаковое содержимое → один файл                                    |
| Adway: Скачать внешние изображения | только URL из ошибок «Внешнее изображение»                            |
| Adway: Обновить кэш SID/Country    | перечитать Sheets                                                     |

### Бесплатный видео-плеер

Команда **Adway: Установить видео-плеер** ставит **бесплатный** Adway-плеер на локальный MP4 (без Hermes / VideoJS / платных виджетов):

- при наличии `.mp4` / `.webm` создаёт `media/` и переносит файл → `media/video.mp4`;
- вставляет `#container_video`, пишет `css/video.css` и `js/video.js`;
- подключает jQuery 3.6.0 с cdnjs (с новой строки в `<head>`).

Сниппет HTML-блока: `adway-video-block`.

При скачивании картинок: уже существующие в `images/` по имени не качаются снова; байт-в-байт дубли схлопываются.

---

## Лицензия

MIT © [Danila Schetinkin](https://github.com/DanilaSchetinkin)
