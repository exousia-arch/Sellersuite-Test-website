/** Tailwind build config. Rebuild after editing any HTML:
 *  npx -y tailwindcss@3.4.17 -c tailwind.config.cjs -i src/input.css -o styles.css --minify
 */
module.exports = {
  content: ['./index.html', './app.html', './ngram.html', './login.html', './request-access.html', './about.html', './privacy.html', './contact.html'],
  theme: { extend: {} },
  plugins: [],
};
