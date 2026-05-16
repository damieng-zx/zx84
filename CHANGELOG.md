# Changelog

## 0.2.11

- File open dialogs now use `showOpenFilePicker` (Chromium) with separate `id` values per file type (snapshot, tape, disk, ROM, font), so each picker remembers its own last-used folder independently. Falls back to `<input type="file">` on unsupported browsers.
