import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router';
import { app as appState } from './services/app-state';
import './style.css';

async function bootstrap(): Promise<void> {
  await appState.init();
  createApp(App).use(router).mount('#app');
}

void bootstrap();
