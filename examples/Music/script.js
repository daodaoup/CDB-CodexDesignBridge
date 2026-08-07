const app = document.querySelector('.app-shell');
const screens = [...document.querySelectorAll('[data-screen]')];
const navItems = [...document.querySelectorAll('.nav-item')];
const miniPlayer = document.querySelector('.mini-player');
const mainPlay = document.querySelector('.main-play');
const progress = document.querySelector('#progress');
const toast = document.querySelector('.toast');
let lastScreen = 'home';
let toastTimer;

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 1600);
}

function showScreen(name) {
  screens.forEach(screen => {
    const active = screen.dataset.screen === name;
    screen.hidden = !active;
    screen.classList.toggle('is-active', active);
    if (active) screen.scrollTop = 0;
  });
  app.classList.toggle('player-open', name === 'player');
  if (name !== 'player') {
    lastScreen = name;
    navItems.forEach(item => item.classList.toggle('is-active', item.dataset.target === name));
  }
}

navItems.forEach(item => item.addEventListener('click', () => showScreen(item.dataset.target)));
document.querySelector('[data-action="open-player"]').addEventListener('click', event => {
  if (event.target.closest('[data-action="toggle-play"]')) return;
  showScreen('player');
});
document.querySelector('[data-action="close-player"]').addEventListener('click', () => showScreen(lastScreen));

function setPlaying(isPlaying) {
  mainPlay.setAttribute('aria-pressed', String(isPlaying));
  mainPlay.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
  miniPlayer.classList.toggle('is-paused', !isPlaying);
}

mainPlay.addEventListener('click', () => setPlaying(mainPlay.getAttribute('aria-pressed') !== 'true'));
document.querySelector('[data-action="toggle-play"]').addEventListener('click', event => {
  event.stopPropagation();
  setPlaying(mainPlay.getAttribute('aria-pressed') !== 'true');
});

function selectTrack(track, artist, duration = '3:54') {
  document.querySelector('#miniTrack').textContent = track;
  document.querySelector('#miniArtist').textContent = artist;
  document.querySelector('#playerTrack').textContent = track;
  document.querySelector('#playerArtist').textContent = artist;
  document.querySelector('#duration').textContent = duration;
  progress.value = 0;
  progress.dispatchEvent(new Event('input'));
  setPlaying(true);
  showToast(`Now playing · ${track}`);
}

document.querySelectorAll('[data-track]').forEach(item => item.addEventListener('click', event => {
  if (event.target.closest('.liked-art')) return;
  const duration = item.querySelector('em')?.textContent || '3:54';
  selectTrack(item.dataset.track, item.dataset.artist, duration);
}));

document.querySelector('.liked-art').addEventListener('click', () => selectTrack('Sweet Disposition', 'The Temper Trap'));
document.querySelector('.hero-play').addEventListener('click', () => {
  selectTrack('Sweet Disposition', 'The Temper Trap');
  showScreen('player');
});

progress.addEventListener('input', () => {
  const value = Number(progress.value);
  progress.style.background = `linear-gradient(to right,var(--ink) ${value}%,rgba(33,29,26,.14) ${value}%)`;
  const seconds = Math.round(234 * value / 100);
  document.querySelector('#elapsed').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2,'0')}`;
});

document.querySelector('.heart-button').addEventListener('click', event => {
  const button = event.currentTarget;
  const liked = button.getAttribute('aria-pressed') === 'true';
  button.setAttribute('aria-pressed', String(!liked));
  showToast(liked ? 'Removed from liked songs' : 'Added to liked songs');
});

document.querySelectorAll('.chip').forEach(chip => chip.addEventListener('click', () => {
  document.querySelectorAll('.chip').forEach(item => item.classList.remove('is-active'));
  chip.classList.add('is-active');
  showToast(`${chip.textContent} selected`);
}));

document.querySelector('#clearQueue').addEventListener('click', () => {
  document.querySelector('#queueList').innerHTML = '<p style="margin:8px;color:var(--muted);font-size:12px">Your queue is clear.</p>';
  showToast('Queue cleared');
});

const requestedScreen = new URLSearchParams(window.location.search).get('screen');
if (['home', 'discover', 'library', 'player'].includes(requestedScreen)) {
  showScreen(requestedScreen);
}
