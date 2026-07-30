import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import './style.css'
import { t } from './composables/useUiLanguage'
import { installFeedbackDiagnostics } from './composables/useFeedbackDiagnostics'
import { installAppBuildSync } from './composables/appBuildSync'

console.log('Welcome to codexui. github: https://github.com/friuns2/codexUI')

installFeedbackDiagnostics()

createApp(App).use(router).mount('#app')

if (import.meta.env.PROD) {
  installAppBuildSync()
}

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    const serviceWorkerVersion = encodeURIComponent(
      import.meta.env.VITE_APP_BUILD_ID ?? import.meta.env.VITE_APP_VERSION ?? 'local',
    )
    navigator.serviceWorker.register(`/sw.js?v=${serviceWorkerVersion}`).catch((error) => {
      console.error(t('Service worker registration failed.'), error)
    })
  })
}
