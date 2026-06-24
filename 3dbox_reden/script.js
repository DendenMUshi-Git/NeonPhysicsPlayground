import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import * as CANNON from 'cannon-es';

// ============================================
// LOADING MANAGER
// ============================================

const loadingManager = {
    progress: 0,
    steps: [
        { name: 'Loading Assets...', weight: 20 },
        { name: 'Initializing Physics...', weight: 30 },
        { name: 'Building Environment...', weight: 25 },
        { name: 'Creating Boxes...', weight: 15 },
        { name: 'Finalizing Setup...', weight: 10 }
    ],
    currentStep: 0,
    stepProgress: 0,

    update(stepIndex, progressInStep) {
        let total = 0;
        for (let i = 0; i < stepIndex; i++) {
            total += this.steps[i].weight;
        }
        total += this.steps[stepIndex].weight * progressInStep;
        this.progress = Math.min(100, Math.round(total));

        const percentEl = document.getElementById('loader-percentage');
        const msgEl = document.getElementById('loader-message');
        const barEl = document.getElementById('progress-bar');
        if (percentEl) percentEl.textContent = this.progress + '%';
        if (msgEl) msgEl.textContent = this.steps[stepIndex].name;
        if (barEl) barEl.style.width = this.progress + '%';
    },

    complete() {
        this.progress = 100;
        document.getElementById('loader-percentage').textContent = '100%';
        document.getElementById('loader-message').textContent = 'Ready!';
        document.getElementById('progress-bar').style.width = '100%';

        setTimeout(() => {
            document.getElementById('loading-overlay').classList.add('hidden');
            document.getElementById('app-container').style.display = 'block';
        }, 500);
    }
};

// ============================================
// GLOBALS
// ============================================

let scene, camera, renderer, orbitControls, transformControls, world;
let boxes = [];
let selectedBox = null, selectedIndex = -1;
let activeMode = 'camera';
let physicsPaused = false, gravityEnabled = true;
let ambientParticles;
let pointLight;
let clock = { getDelta: () => 0 }; // placeholder

// ============================================
// HELPERS
// ============================================

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

let notificationTimeout = null;

function showNotification(message) {
    const existing = document.querySelector('.physics-notification');
    if (existing) existing.remove();
    const notification = document.createElement('div');
    notification.className = 'physics-notification';
    notification.textContent = message;
    notification.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: rgba(10, 10, 25, 0.95);
        backdrop-filter: blur(15px);
        border: 2px solid #ff3366;
        border-radius: 16px;
        padding: 20px 40px;
        color: #fff;
        font-family: 'Orbitron', sans-serif;
        font-size: 1.2rem;
        z-index: 2000;
        box-shadow: 0 0 60px rgba(255, 51, 102, 0.5);
        animation: notificationPop 0.3s ease-out;
        text-align: center;
        pointer-events: none;
    `;
    if (!document.querySelector('#notification-style')) {
        const style = document.createElement('style');
        style.id = 'notification-style';
        style.textContent = `
            @keyframes notificationPop {
                0% { transform: translate(-50%, -50%) scale(0.8); opacity: 0; }
                100% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
            }
        `;
        document.head.appendChild(style);
    }
    document.body.appendChild(notification);
    clearTimeout(notificationTimeout);
    notificationTimeout = setTimeout(() => {
        notification.style.opacity = '0';
        notification.style.transition = 'opacity 0.5s ease';
        setTimeout(() => notification.remove(), 500);
    }, 1500);
}

// ============================================
// SETUP FUNCTIONS
// ============================================

async function setupPhysicsAndScene() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x050510);

    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(8, 6, 10);

    renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
        powerPreference: 'high-performance'
    });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    document.getElementById('app-container').prepend(renderer.domElement);

    orbitControls = new OrbitControls(camera, renderer.domElement);
    orbitControls.enableDamping = true;
    orbitControls.dampingFactor = 0.05;
    orbitControls.autoRotate = false;
    orbitControls.enableZoom = true;
    orbitControls.enablePan = true;
    orbitControls.enableRotate = true;
    orbitControls.maxPolarAngle = Math.PI / 2;
    orbitControls.target.set(0, 1.5, 0);
    orbitControls.touchRotate = true;
    orbitControls.touchZoom = true;
    orbitControls.touchPan = true;
    orbitControls.rotateSpeed = 1.0;
    orbitControls.zoomSpeed = 1.0;
    orbitControls.panSpeed = 0.8;
    orbitControls.screenSpacePanning = true;

    const ambientLight = new THREE.AmbientLight(0x404060);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xfff5e6, 1.0);
    dirLight.position.set(3, 8, 4);
    dirLight.castShadow = true;
    dirLight.receiveShadow = true;
    dirLight.shadow.mapSize.width = 1024;
    dirLight.shadow.mapSize.height = 1024;
    scene.add(dirLight);

    pointLight = new THREE.PointLight(0xff3366, 1.0, 8);
    pointLight.position.set(2, 3, 2);
    pointLight.castShadow = false;
    scene.add(pointLight);

    world = new CANNON.World();
    world.gravity.set(0, -9.82, 0);
    world.broadphase = new CANNON.SAPBroadphase(world);
    world.allowSleep = true;
    world.sleepTimeLimit = 0.5;

    const defaultMaterial = new CANNON.Material('default');
    const contactMaterial = new CANNON.ContactMaterial(defaultMaterial, defaultMaterial, {
        friction: 0.3,
        restitution: 0.1
    });
    world.addContactMaterial(contactMaterial);

    const groundShape = new CANNON.Plane();
    const groundBody = new CANNON.Body({ mass: 0, material: defaultMaterial });
    groundBody.addShape(groundShape);
    groundBody.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
    groundBody.position.y = 0;
    world.addBody(groundBody);

    // store default material for later use
    window._defaultMaterial = defaultMaterial;
}

async function setupEnvironment() {
    const planeGeometry = new THREE.CircleGeometry(12, 32);
    const planeMaterial = new THREE.MeshStandardMaterial({
        color: 0x0a0a1a,
        roughness: 0.3,
        metalness: 0.7,
        emissive: 0x111122,
        transparent: true,
        opacity: 0.7,
        side: THREE.DoubleSide
    });
    const plane = new THREE.Mesh(planeGeometry, planeMaterial);
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = 0;
    plane.receiveShadow = true;
    scene.add(plane);

    const gridHelper = new THREE.GridHelper(12, 16, 0xff3366, 0x3366aa);
    gridHelper.position.y = 0.01;
    scene.add(gridHelper);

    const particleCount = 500;
    const particleGeo = new THREE.BufferGeometry();
    const particlePositions = new Float32Array(particleCount * 3);
    const particleColors = new Float32Array(particleCount * 3);
    for (let i = 0; i < particleCount; i++) {
        const r = 5 + Math.random() * 4;
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        particlePositions[i*3] = Math.sin(phi) * Math.cos(theta) * r;
        particlePositions[i*3+1] = Math.sin(phi) * Math.sin(theta) * r * 0.6;
        particlePositions[i*3+2] = Math.cos(phi) * r;
        const color = new THREE.Color().setHSL(0.6 + Math.random() * 0.4, 0.8, 0.5);
        particleColors[i*3] = color.r;
        particleColors[i*3+1] = color.g;
        particleColors[i*3+2] = color.b;
    }
    particleGeo.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));
    particleGeo.setAttribute('color', new THREE.BufferAttribute(particleColors, 3));
    const particleMat = new THREE.PointsMaterial({
        size: 0.04,
        vertexColors: true,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false
    });
    ambientParticles = new THREE.Points(particleGeo, particleMat);
    scene.add(ambientParticles);

    transformControls = new TransformControls(camera, renderer.domElement);
    transformControls.setSize(1.0);
    transformControls.setMode('translate');
    transformControls.enabled = false;
    scene.add(transformControls);

    transformControls.addEventListener('change', () => {
        if (selectedBox) {
            const mesh = selectedBox.mesh;
            selectedBox.body.position.set(mesh.position.x, mesh.position.y, mesh.position.z);
            selectedBox.body.quaternion.set(mesh.quaternion.x, mesh.quaternion.y, mesh.quaternion.z, mesh.quaternion.w);
            selectedBox.body.velocity.set(0, 0, 0);
            selectedBox.body.angularVelocity.set(0, 0, 0);
        }
    });

    transformControls.addEventListener('dragging-changed', (event) => {
        orbitControls.enabled = !event.value;
    });
}

async function createBoxesAndControls() {
    const MAX_BOXES = 8;
    const defaultMaterial = window._defaultMaterial;

    function createPhysicsBox(position = null, color = null) {
        if (boxes.length >= MAX_BOXES) {
            showNotification(`⚠️ Maximum ${MAX_BOXES} boxes reached!`);
            return null;
        }
        const boxSize = 1.2;
        if (!position) {
            position = {
                x: (Math.random() - 0.5) * 4,
                y: 3 + Math.random() * 4,
                z: (Math.random() - 0.5) * 4
            };
        }
        if (!color) {
            const colors = ['#ff3366', '#33ccff', '#9933ff', '#ff6633', '#33ff66', '#ff33cc', '#ffcc33', '#66ffcc'];
            color = colors[Math.floor(Math.random() * colors.length)];
        }
        const geometry = new THREE.BoxGeometry(boxSize, boxSize, boxSize);
        const material = new THREE.MeshStandardMaterial({
            color: color,
            metalness: 0.7,
            roughness: 0.3,
            emissive: new THREE.Color(color).multiplyScalar(0.1)
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.position.set(position.x, position.y, position.z);
        mesh.userData.boxIndex = boxes.length;

        const edges = new THREE.EdgesGeometry(geometry);
        const lineMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 });
        const wireframe = new THREE.LineSegments(edges, lineMaterial);
        mesh.add(wireframe);
        scene.add(mesh);

        const shape = new CANNON.Box(new CANNON.Vec3(boxSize/2, boxSize/2, boxSize/2));
        const body = new CANNON.Body({
            mass: 1,
            material: defaultMaterial,
            shape: shape,
            position: new CANNON.Vec3(position.x, position.y, position.z)
        });
        world.addBody(body);

        const boxData = {
            mesh: mesh,
            body: body,
            wireframe: wireframe,
            size: boxSize,
            index: boxes.length,
            texture: null,
            defaultColor: color
        };
        boxes.push(boxData);
        updateBoxCount();
        return boxData;
    }

    window.selectBox = function(index) {
        if (selectedBox) {
            selectedBox.mesh.material.emissiveIntensity = 0.1;
            if (selectedBox.wireframe) {
                selectedBox.wireframe.material.color.set(0xffffff);
            }
        }
        if (index >= 0 && index < boxes.length) {
            selectedBox = boxes[index];
            selectedIndex = index;
            selectedBox.mesh.material.emissiveIntensity = 0.5;
            if (selectedBox.wireframe) {
                selectedBox.wireframe.material.color.set(0x33ccff);
            }
            transformControls.attach(selectedBox.mesh);
            transformControls.enabled = true;
            document.getElementById('selectionIndicator').style.display = 'block';
            document.getElementById('selectedInfo').textContent = `📦 Box ${index+1} selected`;
            updateTextureStatus();
        } else {
            selectedBox = null;
            selectedIndex = -1;
            transformControls.detach();
            transformControls.enabled = false;
            document.getElementById('selectionIndicator').style.display = 'none';
            document.getElementById('texture-status').innerHTML =
                `<span class="info-icon">ℹ️</span><span>Select a box to apply texture</span>`;
        }
    };

    createPhysicsBox({ x: -1.5, y: 1.5, z: 0 }, '#ff3366');
    createPhysicsBox({ x: 1.5, y: 1.5, z: 0 }, '#33ccff');

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    function getBoxIntersection(event) {
        const rect = renderer.domElement.getBoundingClientRect();
        const clientX = event.clientX || (event.touches && event.touches[0].clientX);
        const clientY = event.clientY || (event.touches && event.touches[0].clientY);
        if (clientX === undefined) return -1;
        mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, camera);
        const meshes = boxes.map(b => b.mesh);
        const intersects = raycaster.intersectObjects(meshes);
        if (intersects.length > 0) {
            const hitMesh = intersects[0].object;
            return boxes.findIndex(b => b.mesh === hitMesh);
        }
        return -1;
    }

    function onPointerDown(event) {
        if (activeMode !== 'edit') return;
        if (event.button !== undefined && event.button !== 0) return;
        const index = getBoxIntersection(event);
        if (index !== -1) {
            window.selectBox(index);
        } else {
            window.selectBox(-1);
        }
    }

    renderer.domElement.addEventListener('click', onPointerDown);
    renderer.domElement.addEventListener('touchstart', (e) => {
        if (activeMode === 'edit') {
            onPointerDown(e);
        }
    }, { passive: true });

    window.boxes = boxes;
    window.createPhysicsBox = createPhysicsBox;
    window.resetAllBoxes = resetAllBoxes;
    window.updateBoxCount = updateBoxCount;
}

function resetAllBoxes() {
    window.selectBox(-1);
    for (let i = boxes.length - 1; i >= 0; i--) {
        const box = boxes[i];
        world.removeBody(box.body);
        scene.remove(box.mesh);
        if (box.texture) box.texture.dispose();
    }
    boxes.length = 0;
    window.createPhysicsBox({ x: -1.5, y: 1.5, z: 0 }, '#ff3366');
    window.createPhysicsBox({ x: 1.5, y: 1.5, z: 0 }, '#33ccff');
    camera.position.set(8, 6, 10);
    camera.lookAt(0, 1.5, 0);
    orbitControls.target.set(0, 1.5, 0);
    showNotification('🔄 Reset complete!');
}

function updateBoxCount() {
    const countDisplay = document.getElementById('box-count');
    if (countDisplay) countDisplay.textContent = `Boxes: ${boxes.length} / 8`;
    const addBtn = document.getElementById('add-box-btn');
    if (addBtn) {
        addBtn.disabled = boxes.length >= 8;
        addBtn.style.opacity = boxes.length >= 8 ? '0.5' : '1';
        addBtn.style.cursor = boxes.length >= 8 ? 'not-allowed' : 'pointer';
    }
}

function updateTextureStatus() {
    const status = document.getElementById('texture-status');
    if (!selectedBox) {
        status.innerHTML = `<span class="info-icon">ℹ️</span><span>Select a box to apply texture</span>`;
        return;
    }
    if (selectedBox.texture) {
        status.innerHTML = `<span class="info-icon">🖼️</span><span>Texture applied</span>`;
    } else {
        status.innerHTML = `<span class="info-icon">ℹ️</span><span>No texture on this box</span>`;
    }
}

function applyTextureToBox(box, texture) {
    if (box.texture) box.texture.dispose();
    box.texture = texture;
    box.mesh.material.map = texture;
    box.mesh.material.color.set(0xffffff);
    box.mesh.material.emissive.set(0x000000);
    box.mesh.material.needsUpdate = true;
}

function removeTextureFromBox(box) {
    if (!box.texture) { showNotification('ℹ️ No texture to remove'); return; }
    box.texture.dispose();
    box.texture = null;
    box.mesh.material.map = null;
    box.mesh.material.color.set(box.defaultColor);
    box.mesh.material.emissive.set(new THREE.Color(box.defaultColor).multiplyScalar(0.1));
    box.mesh.material.needsUpdate = true;
    document.getElementById('texture-status').innerHTML =
        `<span class="info-icon">ℹ️</span><span>Texture removed</span>`;
    showNotification('🗑️ Texture removed');
}

// ============================================
// UI SETUP
// ============================================

async function setupUIAndEvents() {
    const ui = {
        cameraModeBtn: document.getElementById('camera-mode-btn'),
        editModeBtn: document.getElementById('edit-mode-btn'),
        cameraControls: document.getElementById('camera-controls'),
        editControls: document.getElementById('edit-controls'),
        translateBtn: document.getElementById('translate-btn'),
        rotateBtn: document.getElementById('rotate-btn'),
        scaleBtn: document.getElementById('scale-btn'),
        currentModeSpan: document.getElementById('currentMode'),
        colorPicker: document.getElementById('color-picker'),
        resetBtn: document.getElementById('reset-btn'),
        randomBtn: document.getElementById('random-color-btn'),
        lightingToggle: document.getElementById('lighting-toggle'),
        wireframeToggle: document.getElementById('wireframe-toggle'),
        autoRotateToggle: document.getElementById('auto-rotate-toggle'),
        minimizeBtn: document.getElementById('minimize-btn'),
        hideBtn: document.getElementById('hide-btn'),
        showPanelBtn: document.getElementById('showPanelBtn'),
        restorePanelBtn: document.getElementById('restorePanelBtn'),
        controlPanel: document.getElementById('controlPanel'),
        hiddenIndicator: document.getElementById('hiddenIndicator'),
        minimizedIndicator: document.getElementById('minimizedIndicator'),
        addBoxBtn: document.getElementById('add-box-btn'),
        explodeBtn: document.getElementById('explode-btn'),
        physicsToggleBtn: document.getElementById('physics-toggle-btn'),
        gravityToggle: document.getElementById('gravity-toggle'),
        resetPhysicsBtn: document.getElementById('reset-physics-btn'),
        uploadTextureBtn: document.getElementById('upload-texture-btn'),
        removeTextureBtn: document.getElementById('remove-texture-btn'),
        textureInput: document.getElementById('texture-input')
    };

    function setActiveMode(mode) {
        activeMode = mode;
        ui.cameraModeBtn.classList.toggle('active', mode === 'camera');
        ui.editModeBtn.classList.toggle('active', mode === 'edit');
        const cameraBadge = ui.cameraModeBtn.querySelector('.mode-badge');
        const editBadge = ui.editModeBtn.querySelector('.mode-badge');
        if (cameraBadge) cameraBadge.textContent = mode === 'camera' ? 'ACTIVE' : 'INACTIVE';
        if (editBadge) editBadge.textContent = mode === 'edit' ? 'ACTIVE' : 'INACTIVE';
        ui.cameraControls.style.display = mode === 'camera' ? 'block' : 'none';
        ui.editControls.style.display = mode === 'edit' ? 'block' : 'none';
        ui.currentModeSpan.textContent = mode === 'camera' ? 'CAMERA' : 'EDIT';
        if (mode === 'camera') {
            orbitControls.enabled = true;
            transformControls.enabled = false;
            document.getElementById('selectionIndicator').style.display = 'none';
            renderer.domElement.style.cursor = 'default';
            window.selectBox(-1);
        } else {
            orbitControls.enabled = false;
            if (selectedBox) {
                transformControls.enabled = true;
                document.getElementById('selectionIndicator').style.display = 'block';
            } else {
                transformControls.enabled = false;
                document.getElementById('selectionIndicator').style.display = 'none';
            }
            renderer.domElement.style.cursor = 'pointer';
            showNotification('📦 Click any box to select & transform');
        }
    }

    ui.cameraModeBtn.addEventListener('click', () => setActiveMode('camera'));
    ui.editModeBtn.addEventListener('click', () => setActiveMode('edit'));

    ui.translateBtn.addEventListener('click', () => {
        transformControls.setMode('translate');
        ui.translateBtn.classList.add('active');
        ui.rotateBtn.classList.remove('active');
        ui.scaleBtn.classList.remove('active');
    });
    ui.rotateBtn.addEventListener('click', () => {
        transformControls.setMode('rotate');
        ui.rotateBtn.classList.add('active');
        ui.translateBtn.classList.remove('active');
        ui.scaleBtn.classList.remove('active');
    });
    ui.scaleBtn.addEventListener('click', () => {
        transformControls.setMode('scale');
        ui.scaleBtn.classList.add('active');
        ui.translateBtn.classList.remove('active');
        ui.rotateBtn.classList.remove('active');
    });

    ui.addBoxBtn.addEventListener('click', () => {
        if (boxes.length < 8) {
            const randomColor = '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0');
            window.createPhysicsBox(null, randomColor);
        } else {
            showNotification(`⚠️ Maximum 8 boxes reached!`);
        }
    });

    ui.explodeBtn.addEventListener('click', explodeBoxes);

    ui.resetBtn.addEventListener('click', resetAllBoxes);
    ui.resetPhysicsBtn.addEventListener('click', resetAllBoxes);

    ui.randomBtn.addEventListener('click', () => {
        const randomColor = '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0');
        ui.colorPicker.value = randomColor;
        boxes.forEach(box => {
            box.mesh.material.color.set(randomColor);
            box.mesh.material.emissive.set(new THREE.Color(randomColor).multiplyScalar(0.1));
        });
        pointLight.color.set(randomColor);
        showNotification('🎨 Colors updated!');
    });

    ui.colorPicker.addEventListener('input', (event) => {
        const color = event.target.value;
        boxes.forEach(box => {
            box.mesh.material.color.set(color);
            box.mesh.material.emissive.set(new THREE.Color(color).multiplyScalar(0.1));
        });
        pointLight.color.set(color);
    });

    ui.physicsToggleBtn.addEventListener('click', () => {
        physicsPaused = !physicsPaused;
        ui.physicsToggleBtn.innerHTML = physicsPaused ?
            '<span class="btn-icon">▶️</span><span class="btn-text">RESUME</span>' :
            '<span class="btn-icon">⏸️</span><span class="btn-text">PAUSE</span>';
        showNotification(physicsPaused ? '⏸️ Physics Paused' : '▶️ Physics Resumed');
    });

    ui.gravityToggle.addEventListener('change', (e) => {
        gravityEnabled = e.target.checked;
        world.gravity.set(0, gravityEnabled ? -9.82 : 0, 0);
        showNotification(gravityEnabled ? '🌍 Gravity ON' : '🚀 Gravity OFF');
    });

    ui.lightingToggle.addEventListener('change', (e) => {
        pointLight.intensity = e.target.checked ? 1.0 : 0;
    });

    ui.wireframeToggle.addEventListener('change', (e) => {
        boxes.forEach(box => {
            box.wireframe.visible = e.target.checked;
        });
    });

    ui.autoRotateToggle.addEventListener('change', (e) => {
        orbitControls.autoRotate = e.target.checked;
    });

    ui.minimizeBtn.addEventListener('click', () => {
        ui.controlPanel.classList.add('minimized');
        ui.minimizedIndicator.style.display = 'block';
    });
    ui.hideBtn.addEventListener('click', () => {
        ui.controlPanel.classList.add('hidden');
        ui.hiddenIndicator.style.display = 'block';
    });
    ui.restorePanelBtn.addEventListener('click', () => {
        ui.controlPanel.classList.remove('minimized');
        ui.minimizedIndicator.style.display = 'none';
    });
    ui.showPanelBtn.addEventListener('click', () => {
        ui.controlPanel.classList.remove('hidden');
        ui.hiddenIndicator.style.display = 'none';
    });
    ui.controlPanel.addEventListener('click', (e) => {
        if (ui.controlPanel.classList.contains('minimized')) {
            ui.controlPanel.classList.remove('minimized');
            ui.minimizedIndicator.style.display = 'none';
        }
    });

    ui.uploadTextureBtn.addEventListener('click', () => {
        if (!selectedBox) {
            showNotification('⚠️ Please select a box first!');
            return;
        }
        ui.textureInput.click();
    });

    ui.textureInput.addEventListener('change', (event) => {
        const file = event.target.files[0];
        if (!file) return;
        if (!selectedBox) {
            showNotification('⚠️ Please select a box first!');
            ui.textureInput.value = '';
            return;
        }
        const validTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/jpg'];
        if (!validTypes.includes(file.type)) {
            showNotification('⚠️ Please upload PNG, JPG, JPEG, or WEBP');
            ui.textureInput.value = '';
            return;
        }
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const texture = new THREE.Texture(img);
                texture.needsUpdate = true;
                applyTextureToBox(selectedBox, texture);
                document.getElementById('texture-status').innerHTML =
                    `<span class="info-icon">🖼️</span><span>Texture applied</span>`;
                showNotification('✅ Texture applied!');
            };
            img.src = e.target.result;
            ui.textureInput.value = '';
        };
        reader.readAsDataURL(file);
    });

    ui.removeTextureBtn.addEventListener('click', () => {
        if (!selectedBox) {
            showNotification('⚠️ Please select a box first!');
            return;
        }
        removeTextureFromBox(selectedBox);
    });

    setActiveMode('camera');
}

// ============================================
// EXPLOSION FEATURE
// ============================================

const EXPLOSION_STRENGTH = 8;
const FRAGMENT_LIFETIME = 4;
const FRAGMENT_COUNT = 12;
const PARTICLE_COUNT = 80;

let explosionFragments = [];
let explosionParticles = [];
let explosionFlashes = [];

function explodeBoxes() {
    if (boxes.length === 0) return;
    const boxesToExplode = [...boxes];
    boxesToExplode.forEach(box => {
        const pos = box.mesh.position.clone();
        const color = box.mesh.material.color.clone();
        const boxSize = box.size;
        world.removeBody(box.body);
        scene.remove(box.mesh);
        const index = boxes.indexOf(box);
        if (index !== -1) boxes.splice(index, 1);

        const fragSize = boxSize / 2.5;
        const fragGeo = new THREE.BoxGeometry(fragSize, fragSize, fragSize);
        const fragMat = new THREE.MeshStandardMaterial({
            color: color,
            metalness: 0.6,
            roughness: 0.4,
            emissive: color.clone().multiplyScalar(0.2)
        });
        for (let i = 0; i < FRAGMENT_COUNT; i++) {
            const fragMesh = new THREE.Mesh(fragGeo, fragMat);
            fragMesh.castShadow = true;
            fragMesh.receiveShadow = true;
            const offset = new THREE.Vector3(
                (Math.random() - 0.5) * boxSize * 0.8,
                (Math.random() - 0.5) * boxSize * 0.8,
                (Math.random() - 0.5) * boxSize * 0.8
            );
            fragMesh.position.copy(pos).add(offset);
            scene.add(fragMesh);

            const shape = new CANNON.Box(new CANNON.Vec3(fragSize/2, fragSize/2, fragSize/2));
            const body = new CANNON.Body({
                mass: 0.5,
                material: window._defaultMaterial,
                shape: shape,
                position: new CANNON.Vec3(fragMesh.position.x, fragMesh.position.y, fragMesh.position.z)
            });
            const dir = new THREE.Vector3(
                (Math.random() - 0.5) * 2,
                Math.random() + 0.5,
                (Math.random() - 0.5) * 2
            ).normalize();
            const speed = EXPLOSION_STRENGTH * (0.5 + Math.random() * 1.0);
            const vel = dir.multiplyScalar(speed);
            body.velocity.set(vel.x, vel.y, vel.z);
            body.angularVelocity.set(
                (Math.random() - 0.5) * 10,
                (Math.random() - 0.5) * 10,
                (Math.random() - 0.5) * 10
            );
            world.addBody(body);
            explosionFragments.push({
                mesh: fragMesh,
                body: body,
                timer: 0,
                lifetime: FRAGMENT_LIFETIME * (0.5 + Math.random() * 0.5)
            });
        }

        const pPositions = new Float32Array(PARTICLE_COUNT * 3);
        const pColors = new Float32Array(PARTICLE_COUNT * 3);
        const velocities = [];
        for (let i = 0; i < PARTICLE_COUNT; i++) {
            const offset = new THREE.Vector3(
                (Math.random() - 0.5) * boxSize,
                (Math.random() - 0.5) * boxSize,
                (Math.random() - 0.5) * boxSize
            );
            const pPos = pos.clone().add(offset);
            pPositions[i*3] = pPos.x;
            pPositions[i*3+1] = pPos.y;
            pPositions[i*3+2] = pPos.z;
            const hue = 0.05 + Math.random() * 0.1;
            const c = new THREE.Color().setHSL(hue, 1.0, 0.5 + Math.random() * 0.5);
            pColors[i*3] = c.r;
            pColors[i*3+1] = c.g;
            pColors[i*3+2] = c.b;
            const dir2 = new THREE.Vector3(
                (Math.random() - 0.5) * 2,
                Math.random() + 1,
                (Math.random() - 0.5) * 2
            ).normalize();
            const speed2 = EXPLOSION_STRENGTH * (0.8 + Math.random() * 1.5);
            velocities.push(dir2.multiplyScalar(speed2));
        }
        const pointsGeo = new THREE.BufferGeometry();
        pointsGeo.setAttribute('position', new THREE.BufferAttribute(pPositions, 3));
        pointsGeo.setAttribute('color', new THREE.BufferAttribute(pColors, 3));
        const pointsMat = new THREE.PointsMaterial({
            size: 0.08,
            vertexColors: true,
            transparent: true,
            opacity: 1.0,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        });
        const points = new THREE.Points(pointsGeo, pointsMat);
        scene.add(points);
        explosionParticles.push({
            points: points,
            velocities: velocities,
            timer: 0,
            lifetime: 2.0
        });

        const flashGeo = new THREE.SphereGeometry(0.5, 8, 8);
        const flashMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1.0 });
        const flash = new THREE.Mesh(flashGeo, flashMat);
        flash.position.copy(pos);
        scene.add(flash);
        explosionFlashes.push({ mesh: flash, timer: 0, lifetime: 0.5 });
    });

    window.selectBox(-1);
    updateBoxCount();
    showNotification('💥 BOOM! Explosion!');
}

function updateExplosionEffects(delta) {
    for (let i = explosionFragments.length - 1; i >= 0; i--) {
        const frag = explosionFragments[i];
        frag.timer += delta;
        frag.mesh.position.copy(frag.body.position);
        frag.mesh.quaternion.copy(frag.body.quaternion);
        if (frag.timer > frag.lifetime) {
            world.removeBody(frag.body);
            scene.remove(frag.mesh);
            explosionFragments.splice(i, 1);
        }
    }
    for (let i = explosionParticles.length - 1; i >= 0; i--) {
        const p = explosionParticles[i];
        p.timer += delta;
        const positions = p.points.geometry.attributes.position.array;
        const count = positions.length / 3;
        for (let j = 0; j < count; j++) {
            positions[j*3] += p.velocities[j].x * delta;
            positions[j*3+1] += p.velocities[j].y * delta - 2.0 * delta;
            positions[j*3+2] += p.velocities[j].z * delta;
            p.velocities[j].multiplyScalar(0.98);
        }
        p.points.geometry.attributes.position.needsUpdate = true;
        const progress = p.timer / p.lifetime;
        p.points.material.opacity = Math.max(0, 1 - progress);
        if (p.timer > p.lifetime) {
            scene.remove(p.points);
            explosionParticles.splice(i, 1);
        }
    }
    for (let i = explosionFlashes.length - 1; i >= 0; i--) {
        const flash = explosionFlashes[i];
        flash.timer += delta;
        const progress = flash.timer / flash.lifetime;
        const scale = 1 + progress * 5;
        flash.mesh.scale.set(scale, scale, scale);
        flash.mesh.material.opacity = 1 - progress;
        if (flash.timer > flash.lifetime) {
            scene.remove(flash.mesh);
            explosionFlashes.splice(i, 1);
        }
    }
}

// ============================================
// ANIMATION LOOP (using performance.now())
// ============================================

let prevTime = performance.now();

function animate() {
    requestAnimationFrame(animate);

    const now = performance.now();
    let delta = Math.min((now - prevTime) / 1000, 0.05); // clamp to 50ms max
    prevTime = now;

    if (!physicsPaused) {
        world.step(1/60, delta, 3);
        boxes.forEach((box, index) => {
            if (selectedIndex !== index || !transformControls.dragging) {
                box.mesh.position.copy(box.body.position);
                box.mesh.quaternion.copy(box.body.quaternion);
            }
        });
    }

    updateExplosionEffects(delta);

    if (ambientParticles) {
        ambientParticles.rotation.y += 0.0003;
    }

    orbitControls.update();
    renderer.render(scene, camera);
}

// ============================================
// RESIZE HANDLER
// ============================================

let resizeTimeout;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
        if (camera && renderer) {
            camera.aspect = window.innerWidth / window.innerHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(window.innerWidth, window.innerHeight);
        }
    }, 100);
});

// ============================================
// INITIALIZATION
// ============================================

async function initializeApp() {
    loadingManager.update(0, 0.2);
    await sleep(200);

    loadingManager.update(1, 0.1);
    await setupPhysicsAndScene();
    loadingManager.update(1, 0.5);
    await sleep(150);

    loadingManager.update(2, 0.2);
    await setupEnvironment();
    loadingManager.update(2, 0.7);
    await sleep(150);

    loadingManager.update(3, 0.3);
    await createBoxesAndControls();
    loadingManager.update(3, 0.8);
    await sleep(150);

    loadingManager.update(4, 0.5);
    await setupUIAndEvents();
    loadingManager.update(4, 1.0);

    loadingManager.complete();

    // Start animation after everything is ready
    animate();

    // Prevent default touch actions on canvas
    renderer.domElement.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    renderer.domElement.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

    console.log('🚀 App fully loaded!');
}

// Start the loading sequence
initializeApp();