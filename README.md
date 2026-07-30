# Adway Checker — VS Code Extension

Расширение для проверки HTML лендингов на соответствие требованиям Adway.

**Автор:** Danila Schetinkin  
**GitHub:** https://github.com/DanilaSchetinkin/adway-checker-vscode

---

## Установка

```bash
git clone https://github.com/DanilaSchetinkin/adway-checker-vscode.git
cd adway-checker-vscode
npm install
npm run compile
```

Открыть папку в VS Code → **F5**

---

## Использование

Открыть HTML файл → **правая кнопка мыши**:

- **Adway: Проверить лендинг** — полная проверка файла
- **Adway: Открыть все сниппеты** — меню вставки кода
- **Adway: Вставить код** — быстрая вставка jQuery, формы, скриптов и т.д.

`Ctrl+Alt+A` — проверить лендинг  
`Ctrl+Shift+M` — панель с ошибками

Автодополнение: печатать `adway-` в HTML файле.

---

## Проверки

- DOCTYPE html
- jQuery 3.6.0 в `<head>`
- Lazy loading, scroll, validation скрипты
- Формы: 6 скрытых инпутов, `action="/order.php"`, `method="post"`
- Инпуты `name` и `phone` с `required`
- Ссылки `href="#"`

---

## Обновление

```bash
git pull
npm run compile
```

---

## Лицензия

MIT © Danila Schetinkin
