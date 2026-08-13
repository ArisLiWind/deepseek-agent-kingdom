const canvas = document.getElementById("game-canvas");
const ctx = canvas.getContext("2d");

const bloomCount = document.getElementById("bloom-count");
const stoneCount = document.getElementById("stone-count");
const agentCount = document.getElementById("agent-count");
const spellText = document.getElementById("spell-text");
const zoneName = document.getElementById("zone-name");
const zoneCopy = document.getElementById("zone-copy");
const questCopy = document.getElementById("quest-copy");

const TILE = 32;
const WORLD_W = 40;
const WORLD_H = 22;

const keys = new Set();

const state = {
  bloom: 128,
  stone: 54,
  agents: 12,
  spell: "en",
  adventure: "yes",
  time: 0
};

const player = {
  x: 10 * TILE,
  y: 14 * TILE,
  w: 18,
  h: 24,
  speed: 2.3
};

const companion = {
  x: 8.6 * TILE,
  y: 14.5 * TILE,
  bob: 0
};

const spells = {
  cn: "进入 Aristotle 之门。",
  en: "Enter the Gate of Aristotle."
};

const solidRects = [];
const waterRects = [];

function addRect(list, x, y, w, h) {
  list.push({ x, y, w, h });
}

function setupCollision() {
  solidRects.length = 0;
  waterRects.length = 0;

  addRect(solidRects, 2 * TILE, 4 * TILE, 7 * TILE, 5 * TILE);
  addRect(solidRects, 29 * TILE, 4 * TILE, 7 * TILE, 5 * TILE);
  addRect(solidRects, 3 * TILE, 3 * TILE, 6 * TILE, 3 * TILE);
  addRect(solidRects, 28 * TILE, 3 * TILE, 7 * TILE, 3 * TILE);

  addRect(solidRects, 0, 0, TILE * 2, TILE * WORLD_H);
  addRect(solidRects, TILE * 38, 0, TILE * 2, TILE * WORLD_H);
  addRect(solidRects, 0, 0, TILE * WORLD_W, TILE * 2);
  addRect(solidRects, 0, TILE * 20, TILE * WORLD_W, TILE * 2);

  addRect(solidRects, TILE * 5, TILE * 9, TILE * 5, TILE * 2);
  addRect(solidRects, TILE * 28, TILE * 9, TILE * 6, TILE * 2);

  addRect(waterRects, TILE * 14, TILE * 10, TILE * 13, TILE * 6);
}

function overlaps(a, b) {
  return (
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y
  );
}

function canMove(nx, ny) {
  const next = { x: nx, y: ny, w: player.w, h: player.h };
  for (const rect of solidRects) {
    if (overlaps(next, rect)) return false;
  }
  for (const rect of waterRects) {
    if (overlaps(next, rect)) {
      const onBridge =
        next.x > TILE * 16 &&
        next.x + next.w < TILE * 24 &&
        next.y > TILE * 11 &&
        next.y + next.h < TILE * 13.7;
      if (!onBridge) return false;
    }
  }
  return true;
}

function movePlayer() {
  let dx = 0;
  let dy = 0;
  if (keys.has("ArrowUp") || keys.has("w")) dy -= player.speed;
  if (keys.has("ArrowDown") || keys.has("s")) dy += player.speed;
  if (keys.has("ArrowLeft") || keys.has("a")) dx -= player.speed;
  if (keys.has("ArrowRight") || keys.has("d")) dx += player.speed;

  if (dx !== 0 && dy !== 0) {
    dx *= 0.72;
    dy *= 0.72;
  }

  const nx = player.x + dx;
  if (canMove(nx, player.y)) player.x = nx;
  const ny = player.y + dy;
  if (canMove(player.x, ny)) player.y = ny;
}

function updateZone() {
  if (player.x > TILE * 15 && player.x < TILE * 25 && player.y > TILE * 9 && player.y < TILE * 15) {
    zoneName.textContent = "Moonbridge";
    zoneCopy.textContent = "木桥横跨清溪，这里是从村庄迈向 Aristotle 之门的第一段道路。";
  } else if (player.y < TILE * 9) {
    zoneName.textContent = "Aristotle Gate";
    zoneCopy.textContent = "高地尽头的门已经苏醒，任何 DeepSeek Agent 都会从这里被写入王国世界。";
  } else if (player.x < TILE * 13) {
    zoneName.textContent = "Bloom Village";
    zoneCopy.textContent = "粉树环绕的新手村，适合所有 Agent 开始第一段探索。";
  } else {
    zoneName.textContent = "Riverside Commons";
    zoneCopy.textContent = "河岸公共区连接了木桥、长椅、树林与集体建造空间。";
  }
}

function drawRect(x, y, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

function drawSky() {
  const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
  g.addColorStop(0, "#7bc6ff");
  g.addColorStop(0.62, "#dbf6ff");
  g.addColorStop(1, "#d4f1b8");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  drawRect(100, 40, 120, 24, "#ffffff");
  drawRect(180, 26, 84, 28, "#ffffff");
  drawRect(236, 44, 110, 20, "#ffffff");
  drawRect(760, 72, 130, 24, "#ffffff");
  drawRect(832, 42, 100, 30, "#ffffff");
}

function drawGround() {
  drawRect(0, TILE * 10, canvas.width, canvas.height, "#8fe06b");
  drawRect(0, TILE * 13, canvas.width, canvas.height, "#7ccc5b");

  for (let i = 0; i < 110; i += 1) {
    const px = (i * 117) % canvas.width;
    const py = TILE * 10 + ((i * 47) % (canvas.height - TILE * 10));
    drawRect(px, py, 2, 2, i % 3 === 0 ? "#ffd7f5" : "#fff7b0");
  }
}

function drawPath() {
  const pathTiles = [
    [11, 20], [12, 19], [13, 18], [14, 17], [15, 16], [16, 15], [17, 14], [18, 13],
    [19, 12], [20, 11], [21, 10], [22, 9], [22, 8], [22, 7], [22, 6], [22, 5], [22, 4]
  ];
  for (const [x, y] of pathTiles) {
    drawRect(x * TILE, y * TILE, TILE, TILE, "#f7e4a8");
    drawRect(x * TILE + 2, y * TILE + 2, TILE - 4, TILE - 4, "#efe09f");
  }
}

function drawWater() {
  drawRect(TILE * 14, TILE * 10, TILE * 13, TILE * 6, "#8be7f7");
  drawRect(TILE * 14, TILE * 10 + 6, TILE * 13, TILE * 6 - 12, "#6fd2e8");
  for (let i = 0; i < 18; i += 1) {
    const lx = TILE * 14 + 10 + i * 22;
    const ly = TILE * 10 + 14 + ((i * 13 + state.time * 0.08) % 100);
    ctx.fillStyle = "rgba(255,255,255,0.28)";
    ctx.beginPath();
    ctx.arc(lx, ly, 5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawBridge() {
  drawRect(TILE * 16, TILE * 11, TILE * 8, TILE * 2, "#a07a50");
  for (let i = 0; i < 8; i += 1) {
    drawRect(TILE * (16 + i), TILE * 11 + 2, TILE - 2, TILE * 2 - 4, i % 2 === 0 ? "#bb915d" : "#9d744c");
  }
  for (let i = 0; i < 9; i += 1) {
    drawRect(TILE * (16 + i), TILE * 10 + 22, 4, 20, "#78553a");
  }
}

function drawHouse(x, y, roof, wall) {
  drawRect(x, y + 26, 128, 92, wall);
  drawRect(x + 8, y + 36, 34, 46, "#d9f0f7");
  drawRect(x + 78, y + 36, 34, 46, "#d9f0f7");
  drawRect(x + 52, y + 62, 28, 56, "#8b5237");
  drawRect(x - 10, y, 148, 54, roof);
  drawRect(x, y + 8, 128, 44, roof);
}

function drawTree(x, y, colorA, colorB) {
  drawRect(x + 22, y + 54, 12, 36, "#78533b");
  ctx.fillStyle = colorA;
  ctx.fillRect(x, y + 8, 58, 54);
  ctx.fillStyle = colorB;
  ctx.fillRect(x + 6, y, 46, 48);
  ctx.fillStyle = colorA;
  ctx.fillRect(x + 10, y + 24, 54, 40);
}

function drawVillage() {
  drawHouse(TILE * 2.2, TILE * 4.1, "#b35f48", "#79553d");
  drawHouse(TILE * 28.2, TILE * 4.2, "#904f43", "#7a5540");
  drawRect(TILE * 4.2, TILE * 7.4, 34, 22, "#c6494e");
  drawRect(TILE * 30.6, TILE * 7.4, 34, 22, "#4f87d7");

  drawTree(TILE * 1.3, TILE * 2.7, "#db649d", "#c4478c");
  drawTree(TILE * 5.9, TILE * 2.1, "#e16fa7", "#ca4a8f");
  drawTree(TILE * 29.6, TILE * 2.2, "#d45b95", "#bf417f");
  drawTree(TILE * 34.0, TILE * 2.9, "#dc6ca2", "#c84f8a");

  drawTree(TILE * 4.2, TILE * 14.6, "#74bf62", "#5aa74f");
  drawTree(TILE * 29.4, TILE * 14.4, "#74bf62", "#5aa74f");
}

function drawBenchArea() {
  drawRect(TILE * 28.4, TILE * 11.0, 60, 12, "#7a5b3c");
  drawRect(TILE * 29.0, TILE * 10.6, 48, 8, "#8e6d49");
  drawRect(TILE * 28.5, TILE * 10.4, 4, 26, "#765338");
  drawRect(TILE * 30.0, TILE * 10.4, 4, 26, "#765338");
}

function drawGate() {
  drawRect(TILE * 18.4, TILE * 2.4, TILE * 5, TILE * 2, "#c6d5e8");
  drawRect(TILE * 19.0, TILE * 1.2, TILE * 0.8, TILE * 4.5, "#e7eef9");
  drawRect(TILE * 22.2, TILE * 1.2, TILE * 0.8, TILE * 4.5, "#e7eef9");
  drawRect(TILE * 19.8, TILE * 2.1, TILE * 2.3, TILE * 2.4, "#88b6ff");
}

function drawPlayer() {
  drawRect(player.x, player.y, player.w, player.h, "#2d4f9e");
  drawRect(player.x + 3, player.y - 10, player.w - 6, 12, "#f9cda8");
  drawRect(player.x + 5, player.y + 8, 8, 8, "#dff8ff");
  drawRect(player.x + 9, player.y + 12, 6, 6, "#f9a74a");
}

function drawCompanion() {
  const bob = Math.sin(companion.bob) * 2;
  drawRect(companion.x, companion.y + bob, 18, 14, "#8b5d3b");
  drawRect(companion.x + 4, companion.y - 6 + bob, 10, 10, "#fff0d4");
  drawRect(companion.x + 2, companion.y - 10 + bob, 4, 6, "#d67d57");
  drawRect(companion.x + 12, companion.y - 10 + bob, 4, 6, "#d67d57");
}

function drawStartPrompt() {
  if (state.adventure !== "yes") return;
  ctx.fillStyle = "rgba(16, 27, 55, 0.74)";
  ctx.fillRect(TILE * 16, TILE * 2.2, TILE * 9, TILE * 4);
  ctx.fillStyle = "#eef7ff";
  ctx.font = "bold 18px monospace";
  ctx.fillText("START NEW ADVENTURE?", TILE * 16.5, TILE * 3.4);
  ctx.fillStyle = "#fff6af";
  ctx.fillText("> YES", TILE * 18.6, TILE * 4.5);
  ctx.fillStyle = "#d2d9ef";
  ctx.fillText("  NO", TILE * 18.6, TILE * 5.5);
}

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawSky();
  drawGround();
  drawPath();
  drawWater();
  drawVillage();
  drawBenchArea();
  drawBridge();
  drawGate();
  drawCompanion();
  drawPlayer();
  drawStartPrompt();
}

function tick() {
  state.time += 1;
  companion.bob += 0.08;
  movePlayer();
  updateZone();
  render();
  requestAnimationFrame(tick);
}

document.addEventListener("keydown", (event) => {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  keys.add(key);

  if (key === "1") {
    state.spell = "cn";
    spellText.textContent = spells.cn;
  }
  if (key === "2") {
    state.spell = "en";
    spellText.textContent = spells.en;
  }
  if (key === "e") {
    state.bloom += 3;
    state.stone += 1;
    bloomCount.textContent = String(state.bloom);
    stoneCount.textContent = String(state.stone);
    if (zoneName.textContent === "Aristotle Gate") {
      state.agents += 1;
      agentCount.textContent = String(state.agents);
      questCopy.textContent = "A new Agent has crossed the Gate and joined the kingdom world.";
    }
  }
});

document.addEventListener("keyup", (event) => {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  keys.delete(key);
});

document.addEventListener("click", (event) => {
  const button = event.target.closest(".choice-button");
  if (!button) return;
  const choice = button.dataset.choice;
  state.adventure = choice;
  document.querySelectorAll(".choice-button").forEach((item) => {
    item.classList.toggle("is-active", item.dataset.choice === choice);
  });
  questCopy.textContent =
    choice === "yes"
      ? "Choose YES to awaken the bridge route and step toward the Gate."
      : "Choose NO to remain in the village and prepare your first personal realm.";
});

setupCollision();
spellText.textContent = spells.en;
render();
tick();
