# Front Intelligence

Front Intelligence is a performance-first VS Code extension that supplements Vue and CSS-preprocessor project intelligence.

It helps with:

- CSS/SCSS/SASS/LESS/Stylus/PostCSS alias imports.
- Alias imports inside Vue/Svelte/Astro/HTML style blocks.
- Vue global component file navigation.
- Vue component JSDoc, props, and emits hover/completion metadata.
- Vue provide/inject string-key navigation.

The extension is designed to stay responsive on low-performance machines and to use higher-performance machines for faster background indexing.

## Alias Resolution

Aliases are detected automatically from:

- `tsconfig.json`
- `jsconfig.json`
- `vite.config.*`
- `webpack.config.*`
- `vue.config.*`
- `nuxt.config.*`
- `config.*`

You can also define aliases manually:

```json
{
  "frontIntelligence.alias.custom": {
    "@": "src",
    "@components": "src/components",
    "@styles": ["src/styles", "src/assets/styles"]
  }
}
```

Manual aliases are preferred by default. The old `aliasFileFinder.aliases` setting is still supported for compatibility.

## Performance

```json
{
  "frontIntelligence.performance.mode": "balanced"
}
```

Available modes:

- `lowPower`: minimal background work and conservative concurrency.
- `balanced`: default lazy indexing with idle background work.
- `highPerformance`: more aggressive background indexing and higher concurrency.

## Commands

- `Front Intelligence: 清除缓存`
- `Front Intelligence: 显示已解析别名`
- `Front Intelligence: 显示索引状态`
