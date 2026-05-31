if (window.location.hash.length > 1) {
  try {
    const target = document.getElementById(decodeURIComponent(window.location.hash.slice(1)));
    if (target) target.scrollIntoView({ block: "start" });
  } catch (_) {}
}
