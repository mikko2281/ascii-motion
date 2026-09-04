(() => {
  "use strict";

  const palettes = {
    dense: " .,:;irsXA253hMHGS#9B&@",
    classic: " .:-=+*#%@",
    blocks: " ░▒▓█",
    minimal: " .+@",
  };

  const brailleBits = [
    [0x01, 0x08],
    [0x02, 0x10],
    [0x04, 0x20],
    [0x40, 0x80],
  ];

  const elements = {
    fileInput: document.querySelector("#fileInput"),
    chooseButton: document.querySelector("#chooseButton"),
    dropZone: document.querySelector("#dropZone"),
    sourceImage: document.querySelector("#sourceImage"),
    sourceMeta: document.querySelector("#sourceMeta"),
    resultMeta: document.querySelector("#resultMeta"),
    asciiOutput: document.querySelector("#asciiOutput"),
    asciiViewport: document.querySelector("#asciiViewport"),
    statusMessage: document.querySelector("#statusMessage"),
    workCanvas: document.querySelector("#workCanvas"),
    gridWidth: document.querySelector("#gridWidth"),
    gridValue: document.querySelector("#gridValue"),
    contrast: document.querySelector("#contrast"),
    contrastValue: document.querySelector("#contrastValue"),
    brightness: document.querySelector("#brightness"),
    brightnessValue: document.querySelector("#brightnessValue"),
    palette: document.querySelector("#palette"),
    invert: document.querySelector("#invert"),
    resetButton: document.querySelector("#resetButton"),
    downloadPng: document.querySelector("#downloadPng"),
    downloadTxt: document.querySelector("#downloadTxt"),
    copyText: document.querySelector("#copyText"),
  };

  const state = {
    image: null,
    sourceUrl: "",
    sourceName: "ascii-motion-demo",
    plainText: "",
    renderedRows: [],
    renderFrame: 0,
  };

  function selectedValue(name) {
    return document.querySelector(`input[name="${name}"]:checked`).value;
  }

  function settings() {
    return {
      style: selectedValue("style"),
      colorMode: selectedValue("colorMode"),
      width: Number(elements.gridWidth.value),
      contrast: Number(elements.contrast.value),
      brightness: Number(elements.brightness.value),
      palette: elements.palette.value,
      invert: elements.invert.checked,
    };
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function adjustedLuminance(red, green, blue, options) {
    let value = red * 0.2126 + green * 0.7152 + blue * 0.0722;
    value = (value - 128) * options.contrast + 128 + options.brightness;
    value = clamp(value, 0, 255);
    return options.invert ? 255 - value : value;
  }

  function updateLabels() {
    elements.gridValue.value = `${elements.gridWidth.value} столбцов`;
    elements.contrastValue.value = Number(elements.contrast.value).toFixed(1);
    const brightness = Number(elements.brightness.value);
    elements.brightnessValue.value = brightness > 0 ? `+${brightness}` : String(brightness);
    elements.palette.disabled = selectedValue("style") === "braille";
  }

  function setStatus(message, kind = "") {
    elements.statusMessage.textContent = message;
    elements.statusMessage.className = `status-message${kind ? ` is-${kind}` : ""}`;
  }

  function scheduleRender() {
    updateLabels();
    cancelAnimationFrame(state.renderFrame);
    state.renderFrame = requestAnimationFrame(renderAscii);
  }

  function sampleImage(image, width, height) {
    const canvas = elements.workCanvas;
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.clearRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    return context.getImageData(0, 0, width, height).data;
  }

  function renderAscii() {
    if (!state.image) return;

    const options = settings();
    const sourceWidth = state.image.naturalWidth || state.image.width;
    const sourceHeight = state.image.naturalHeight || state.image.height;
    const columns = options.width;
    const rows = clamp(Math.round(columns * (sourceHeight / sourceWidth) * 0.5), 8, 220);
    const isBraille = options.style === "braille";
    const sampleWidth = isBraille ? columns * 2 : columns;
    const sampleHeight = isBraille ? rows * 4 : rows;
    const pixels = sampleImage(state.image, sampleWidth, sampleHeight);
    const renderedRows = [];
    const outputFragment = document.createDocumentFragment();

    for (let row = 0; row < rows; row += 1) {
      const line = [];
      const lineNode = document.createElement("span");
      for (let column = 0; column < columns; column += 1) {
        let character;
        let red = 0;
        let green = 0;
        let blue = 0;
        let samples = 0;

        if (isBraille) {
          let code = 0;
          for (let dotY = 0; dotY < 4; dotY += 1) {
            for (let dotX = 0; dotX < 2; dotX += 1) {
              const x = column * 2 + dotX;
              const y = row * 4 + dotY;
              const index = (y * sampleWidth + x) * 4;
              const r = pixels[index];
              const g = pixels[index + 1];
              const b = pixels[index + 2];
              const alpha = pixels[index + 3] / 255;
              red += r * alpha;
              green += g * alpha;
              blue += b * alpha;
              samples += 1;
              const luminance = adjustedLuminance(r * alpha, g * alpha, b * alpha, options);
              const orderedThreshold = 92 + ((dotX + dotY * 2) % 4) * 28;
              if (luminance >= orderedThreshold) code |= brailleBits[dotY][dotX];
            }
          }
          character = String.fromCodePoint(0x2800 + code);
        } else {
          const index = (row * sampleWidth + column) * 4;
          const alpha = pixels[index + 3] / 255;
          red = pixels[index] * alpha;
          green = pixels[index + 1] * alpha;
          blue = pixels[index + 2] * alpha;
          samples = 1;
          const luminance = adjustedLuminance(red, green, blue, options);
          const characters = palettes[options.palette];
          character = characters[Math.round((luminance / 255) * (characters.length - 1))];
        }

        const cell = {
          character,
          color: `rgb(${Math.round(red / samples)}, ${Math.round(green / samples)}, ${Math.round(blue / samples)})`,
        };
        line.push(cell);

        if (options.colorMode === "color" && character.trim()) {
          const cellNode = document.createElement("span");
          cellNode.textContent = character;
          cellNode.style.color = cell.color;
          lineNode.appendChild(cellNode);
        } else {
          lineNode.appendChild(document.createTextNode(character));
        }
      }
      renderedRows.push(line);
      outputFragment.appendChild(lineNode);
      if (row < rows - 1) outputFragment.appendChild(document.createTextNode("\n"));
    }

    elements.asciiOutput.replaceChildren(outputFragment);
    state.renderedRows = renderedRows;
    state.plainText = renderedRows.map((line) => line.map((cell) => cell.character).join("")).join("\n");
    elements.resultMeta.textContent = `${columns} × ${rows} / ${columns * rows} символов`;
    fitPreview(columns, rows);
  }

  function fitPreview(columns, rows) {
    const viewportWidth = Math.max(260, elements.asciiViewport.clientWidth - 36);
    const viewportHeight = Math.max(260, elements.asciiViewport.clientHeight - 36);
    const byWidth = viewportWidth / (columns * 0.62);
    const byHeight = viewportHeight / rows;
    const fontSize = clamp(Math.min(byWidth, byHeight), 4, 15);
    elements.asciiOutput.style.setProperty("--preview-font-size", `${fontSize}px`);
  }

  function makeDemoImage() {
    const canvas = document.createElement("canvas");
    canvas.width = 960;
    canvas.height = 620;
    const context = canvas.getContext("2d");
    const gradient = context.createRadialGradient(470, 285, 20, 470, 285, 500);
    gradient.addColorStop(0, "#d9ff72");
    gradient.addColorStop(0.38, "#50bda2");
    gradient.addColorStop(0.72, "#173c55");
    gradient.addColorStop(1, "#050707");
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = "rgba(255,255,255,.82)";
    context.lineWidth = 5;
    for (let radius = 70; radius < 290; radius += 48) {
      context.beginPath();
      context.arc(480, 310, radius, 0, Math.PI * 2);
      context.stroke();
    }
    context.fillStyle = "#050707";
    context.font = "900 154px Arial, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText("ASCII", 480, 310);
    context.fillStyle = "rgba(198,255,46,.92)";
    context.font = "700 28px monospace";
    context.fillText("MOTION / BROWSER DEMO", 480, 430);
    return canvas.toDataURL("image/png");
  }

  function loadImageFromUrl(url, name, isDemo = false) {
    const image = new Image();
    image.onload = () => {
      state.image = image;
      state.sourceName = name.replace(/\.[^.]+$/, "") || "ascii-motion";
      elements.sourceImage.src = url;
      elements.sourceMeta.textContent = `${image.naturalWidth} × ${image.naturalHeight}`;
      setStatus(
        isDemo ? "Сейчас показан встроенный пример. Загрузите своё изображение, чтобы начать." : "Изображение загружено. Меняйте настройки — результат обновляется сразу.",
        isDemo ? "" : "success",
      );
      scheduleRender();
    };
    image.onerror = () => setStatus("Не удалось прочитать изображение. Попробуйте другой файл.", "error");
    image.src = url;
  }

  function handleFile(file) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setStatus("Поддерживаются изображения JPG, PNG, WebP и GIF.", "error");
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setStatus("Для демо выберите файл размером не более 20 МБ.", "error");
      return;
    }
    if (state.sourceUrl) URL.revokeObjectURL(state.sourceUrl);
    state.sourceUrl = URL.createObjectURL(file);
    loadImageFromUrl(state.sourceUrl, file.name);
  }

  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadText() {
    downloadBlob(new Blob([state.plainText], { type: "text/plain;charset=utf-8" }), `${state.sourceName}-ascii.txt`);
    setStatus("TXT-файл сохранён в UTF-8.", "success");
  }

  function downloadPng() {
    if (!state.renderedRows.length) return;
    const options = settings();
    const fontSize = options.style === "braille" ? 16 : 14;
    const lineHeight = Math.ceil(fontSize * 1.15);
    const cellWidth = Math.ceil(fontSize * 0.64);
    const padding = 24;
    const width = state.renderedRows[0].length * cellWidth + padding * 2;
    const height = state.renderedRows.length * lineHeight + padding * 2;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    context.fillStyle = "#050707";
    context.fillRect(0, 0, width, height);
    context.font = `${fontSize}px "Cascadia Mono", "Segoe UI Symbol", Consolas, monospace`;
    context.textBaseline = "top";

    state.renderedRows.forEach((line, rowIndex) => {
      line.forEach((cell, columnIndex) => {
        context.fillStyle = options.colorMode === "color" ? cell.color : "#f4f7f5";
        context.fillText(cell.character, padding + columnIndex * cellWidth, padding + rowIndex * lineHeight);
      });
    });

    canvas.toBlob((blob) => {
      if (!blob) return;
      downloadBlob(blob, `${state.sourceName}-ascii.png`);
      setStatus("PNG-изображение сохранено.", "success");
    }, "image/png");
  }

  async function copyText() {
    try {
      await navigator.clipboard.writeText(state.plainText);
      setStatus("ASCII-текст скопирован в буфер обмена.", "success");
    } catch {
      setStatus("Браузер не разрешил копирование. Скачайте результат как TXT.", "error");
    }
  }

  function resetControls() {
    document.querySelector('input[name="style"][value="classic"]').checked = true;
    document.querySelector('input[name="colorMode"][value="mono"]').checked = true;
    elements.gridWidth.value = "88";
    elements.contrast.value = "1.2";
    elements.brightness.value = "0";
    elements.palette.value = "dense";
    elements.invert.checked = false;
    scheduleRender();
    setStatus("Настройки возвращены к исходным.", "success");
  }

  elements.chooseButton.addEventListener("click", () => elements.fileInput.click());
  elements.fileInput.addEventListener("change", (event) => handleFile(event.target.files[0]));
  elements.dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    elements.dropZone.classList.add("is-dragging");
  });
  elements.dropZone.addEventListener("dragleave", () => elements.dropZone.classList.remove("is-dragging"));
  elements.dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove("is-dragging");
    handleFile(event.dataTransfer.files[0]);
  });

  document.querySelectorAll('input[name="style"], input[name="colorMode"], #gridWidth, #contrast, #brightness, #palette, #invert').forEach((control) => {
    control.addEventListener("input", scheduleRender);
    control.addEventListener("change", scheduleRender);
  });
  elements.resetButton.addEventListener("click", resetControls);
  elements.downloadTxt.addEventListener("click", downloadText);
  elements.downloadPng.addEventListener("click", downloadPng);
  elements.copyText.addEventListener("click", copyText);
  window.addEventListener("resize", () => {
    if (state.renderedRows.length) fitPreview(state.renderedRows[0].length, state.renderedRows.length);
  });

  loadImageFromUrl(makeDemoImage(), "ascii-motion-demo.png", true);
})();
