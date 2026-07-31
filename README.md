# Adway Checker

Расширение для **VS Code** : проверка HTML-лендингов на требования Adway и быстрые правки прямо в редакторе.

**Автор:** [Danila Schetinkin](https://github.com/DanilaSchetinkin)  
**Репозиторий:** [adway-checker-vscode](https://github.com/DanilaSchetinkin/adway-checker-vscode)

---

## О проекте

Чекер смотрит типичные проблемы лендинга: форма заказа, jQuery, скрипты, ссылки, локальные пути, внешние картинки и т.д. Результаты показываются:

- в панели **Problems**;
- в боковой панели **Adway → Results**;
- во webview **«Результаты проверки Adway»** (после ручной проверки).

Из панели результатов:

- **ЛКМ** — переход к строке ошибки / предупреждения;
- **ПКМ** — команды исправления (вставить jQuery, починить форму, скачать картинку и т.д.).

Также есть автофикс (Quick Fix / лампочка), сниппеты `adway-*`, структура папок проекта и скачивание внешних изображений из ошибок в `images/`.

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

Контекстное меню редактора (HTML): проверка, очистка, форма, пути, сниппеты, структура проекта.

Автодополнение: в HTML набрать `adway-`.

---



## Горячие клавиши

Работают в HTML-редакторе. На Mac вместо `Ctrl` — `Cmd`.


| Клавиши        | Команда                                           |
| -------------- | ------------------------------------------------- |
| **Ctrl+Alt+A** | Проверить лендинг                                 |
| **Ctrl+Alt+C** | Почистить лендинг (target, picture, href)         |
| **Ctrl+Alt+F** | Починить форму заказа                             |
| **Ctrl+Alt+P** | Исправить все локальные пути (images/css/js)      |
| **Ctrl+Alt+H** | Заменить все `href` у `<a>` на `#`                |
| **Ctrl+Alt+R** | Показать панель результатов (дерево Adway)        |
| **Ctrl+Alt+L** | Вставить lazy loading                             |
| **Ctrl+Alt+V** | Вставить валидаторы                               |
| **Ctrl+Alt+S** | Вставить все обязательные скрипты                 |
| **Ctrl+Alt+M** | Удалить HTML-комментарии                          |
| **Ctrl+Alt+D** | Скачать внешние изображения из ошибок → `images/` |
| **Ctrl+Alt+O** | Открыть внешние изображения в браузере (Save as)  |


Панель Problems VS Code: **Ctrl+Shift+M**.

---



## Что проверяется

- `<!DOCTYPE html>`
- jQuery 3.6.0 в `<head>` (CDN cdnjs)
- Скрипты: lazy loading, прокрутка к `#oneform`, валидация
- Форма: `action="/order.php"`, `method="post"`, 6 скрытых инпутов, `required` у name/phone
- `id="oneform"`, отсутствие лишнего `<base>`
- Ссылки `<a href>` (в т.ч. `#`, offer/tel/mailto)
- Атрибуты `target`, `<picture>` / `<source>`
- Локальные пути к файлам (подсказки `images/` / `css/` / `js/`)
- Внешние изображения / CSS / JS (вне whitelist)
- SID/Country (если настроен Sheets)
- Эвристика пустых / дублирующихся / неиспользуемых скриптов

---



## Полезные команды


| Команда                            | Зачем                                            |
| ---------------------------------- | ------------------------------------------------ |
| Adway: Создать структуру проекта   | `images/`, `css/`, `js/`, `other/`, `index.html` |
| Adway: Почистить лендинг           | target, flatten picture, нормализация href       |
| Adway: Починить форму заказа       | action/method/oneform/required/hidden            |
| Adway: Скачать внешние изображения | только URL из ошибок «Внешнее изображение»       |
| Adway: Обновить кэш SID/Country    | перечитать Sheets                                |


При скачивании картинок: уже существующие в `images/` по имени не качаются снова; байт-в-байт дубли схлопываются (в уведомлении пишутся удалённые имена).

---



## Лицензия

MIT © [Danila Schetinkin](https://github.com/DanilaSchetinkin)