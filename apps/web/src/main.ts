import {createApp} from 'vue';
import {createRouter,createWebHistory} from 'vue-router';
import App from './App.vue';
import Doudizhu from './pages/DoudizhuPlay.vue';
import './style.css';
const router=createRouter({history:createWebHistory(),routes:[{path:'/games/doudizhu',component:Doudizhu},{path:'/:pathMatch(.*)*',redirect:'/games/doudizhu'}]});createApp(App).use(router).mount('#app');
