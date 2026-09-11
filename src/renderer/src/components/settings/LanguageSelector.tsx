import { useTranslation } from 'react-i18next'
import { supportedLanguages } from '@shared/i18n'

export function LanguageSelector() {
  const { i18n } = useTranslation()

  const current = i18n.resolvedLanguage || 'en'

  return (
    <label className="settings-field-copy">
      <h3>Language</h3>
      <p>Select your preferred language</p>
      <select
        value={current}
        onChange={(e) => void i18n.changeLanguage(e.target.value)}
        className="language-select"
      >
        {supportedLanguages.map((lang) => (
          <option key={lang.code} value={lang.code}>
            {lang.name}
          </option>
        ))}
      </select>
    </label>
  )
}
