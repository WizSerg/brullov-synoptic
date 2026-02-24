import en from "./locales/en.json";
import ru from "./locales/ru.json";
import be from "./locales/be.json";

export const DEFAULT_LANGUAGE = "en";
export const LANGUAGE_STORAGE_KEY = "synoptic.ui.language";

export const dictionaries = { en, ru, be };

export const languageOptions = [
  { value: "en", label: en["language.name"] },
  { value: "ru", label: ru["language.name"] },
  { value: "be", label: be["language.name"] }
];

export const normalizeLanguage = (lang) => {
  if (!lang || typeof lang !== "string") {
    return DEFAULT_LANGUAGE;
  }
  return Object.prototype.hasOwnProperty.call(dictionaries, lang) ? lang : DEFAULT_LANGUAGE;
};

export const translate = (language, key, params = {}) => {
  const lang = normalizeLanguage(language);
  const text = dictionaries[lang]?.[key] ?? dictionaries[DEFAULT_LANGUAGE]?.[key] ?? key;
  return Object.entries(params).reduce(
    (result, [paramKey, value]) => result.replaceAll(`{${paramKey}}`, `${value}`),
    text
  );
};
