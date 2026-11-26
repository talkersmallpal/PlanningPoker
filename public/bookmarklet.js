(() => {
  const base = location.origin;
  const code = "javascript:(()=>{const s=new Set();document.querySelectorAll('a[href*=\"/browse/\"]').forEach(a=>{const m=a.href.match(/^(https:\\/\\/[^/]+\\/browse\\/[A-Z][A-Z0-9]+-\\d+)/);if(m)s.add(m[1]);});if(!s.size){alert('No Jira tickets found on this page');window.open('" + base + "/','_blank');return;}window.open('" + base + "/new?tickets='+encodeURIComponent([...s].join(',')),'_blank');})();";
  document.getElementById('bmLink').setAttribute('href', code);
  document.getElementById('bmCode').value = code;
  document.getElementById('bmBase').textContent = base;
  document.getElementById('bmCopy').addEventListener('click', async () => {
    const ta = document.getElementById('bmCode');
    try { await navigator.clipboard.writeText(code); } catch { ta.select(); document.execCommand('copy'); }
    document.getElementById('bmMsg').textContent = 'Copied';
  });
})();
