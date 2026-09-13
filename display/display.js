import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.1/build/three.module.js';
import { GLTFLoader } from 'https://cdn.jsdelivr.net/npm/three@0.160.1/examples/jsm/loaders/GLTFLoader.js';

const canvas = document.querySelector('#model');
const stage = document.querySelector('#stage');
const status = document.querySelector('#model-status');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.18;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, .1, 100);
camera.position.set(0, .25, 7);
const key = new THREE.DirectionalLight(0xffead4, 4.3); key.position.set(3, 5, 5); scene.add(key);
const rim = new THREE.DirectionalLight(0xa5c7df, 3.4); rim.position.set(-5, 2, -2); scene.add(rim);
scene.add(new THREE.HemisphereLight(0xf8e3cc, 0x1a1b1b, 2.1));
let product, targetY = -.35, targetX = 0, autoRotate = true, dragging = false, lastX = 0, lastY = 0;
new GLTFLoader().load('onyxvelor3d.glb', gltf => {
  product = gltf.scene;
  const box = new THREE.Box3().setFromObject(product), size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  product.position.sub(center);
  const scale = 3.45 / Math.max(size.x, size.y, size.z); product.scale.setScalar(scale);
  product.position.y = -.4;
  product.rotation.y = -.35;
  scene.add(product); status.textContent = 'System ready'; status.classList.add('ready');
}, undefined, () => { status.textContent = '3D preview unavailable'; });
function resize(){const r=stage.getBoundingClientRect();camera.aspect=r.width/r.height;camera.updateProjectionMatrix();renderer.setSize(r.width,r.height,false)}
addEventListener('resize', resize); resize();
function render(t){requestAnimationFrame(render);if(product){if(autoRotate&&!dragging)targetY+=.003;product.rotation.y += (targetY-product.rotation.y)*.055;product.rotation.x += (targetX-product.rotation.x)*.055;product.position.y=-.4+Math.sin(t*.0008)*.035}renderer.render(scene,camera)}requestAnimationFrame(render);
stage.addEventListener('pointerdown', e=>{dragging=true;autoRotate=false;lastX=e.clientX;lastY=e.clientY;stage.setPointerCapture(e.pointerId)});
stage.addEventListener('pointermove', e=>{if(!dragging)return;targetY+=(e.clientX-lastX)*.012;targetX=Math.max(-.22,Math.min(.22,targetX+(e.clientY-lastY)*.006));lastX=e.clientX;lastY=e.clientY});
stage.addEventListener('pointerup',()=>{dragging=false});
document.querySelector('#spin').addEventListener('click',()=>{autoRotate=true;targetX=0});
