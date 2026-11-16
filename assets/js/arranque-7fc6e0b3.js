/* Lo único que corre antes de pintar la página (script clásico, en <head>):
   1. las direcciones relativas apuntan a la carpeta de la app, también en direcciones limpias como /asig/PJ6;
   2. el tema claro u oscuro que eligió el usuario, para que no parpadee. */
(function () {
  var b = document.createElement("base");
  b.href = /^\/clarea(\/|$)/.test(location.pathname) ? "/clarea/" : "/";
  document.head.appendChild(b);
  try {
    var t = JSON.parse(localStorage.getItem("clarea-theme"));
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  } catch (e) {}
})();
