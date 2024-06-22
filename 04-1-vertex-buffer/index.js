async function main() {
  const adapter = await navigator.gpu?.requestAdapter();
  const device = await adapter?.requestDevice();
  if (!device) {
    fail('need a browser that supports WebGPU');
    return;
  }

  const canvas = document.querySelector('canvas');
  const context = canvas.getContext('webgpu');
  const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
  context.configure({
    device,
    format: presentationFormat,
  });

  const module = device.createShaderModule({
    label: 'our hardcoded red triangle shaders',
    code: `
      struct VSOutput {
        @builtin(position) position: vec4f,
        @location(0) color: vec4f,
      }
      
      struct OurStruct {
        color: vec4f,
        offset: vec2f,
      }
      
      struct OtherStruct {
        scale: vec2f,
      }
      
      struct Vertex {
        @location(0) position: vec2f,
        @location(1) color: vec4f,
        @location(2) offset: vec2f,
        @location(3) scale: vec2f,
        @location(4) perVertexColor: vec3f,
      }
    
      @vertex 
      fn vs(vert: Vertex) -> VSOutput {
        var vsOut: VSOutput;
        vsOut.position = vec4f(vert.position * vert.scale + vert.offset, 0.0, 1.0);
        vsOut.color = vert.color * vec4f(vert.perVertexColor, 1);
        return vsOut;
      }
      
      @fragment
      fn fs(vsOut: VSOutput) -> @location(0) vec4f {
        return vsOut.color;
      }
    `
  });

  const pipeline = device.createRenderPipeline({
    label: 'our hardcoded red triangle pipeline',
    layout: 'auto',
    vertex: {
      module,
      entryPoint: 'vs',
      buffers: [
        {
          arrayStride: 2 * 4 + 4,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },
            { shaderLocation: 4, offset: 8, format: 'unorm8x4' },
          ],
        },
        {
          arrayStride: 4 + 2 * 4,
          stepMode: 'instance',
          attributes: [
            { shaderLocation: 1, offset: 0, format: 'unorm8x4' },   // color
            { shaderLocation: 2, offset: 4, format: 'float32x2' },  // offset
          ],
        },
        {
          arrayStride: 2 * 4,
          stepMode: 'instance',
          attributes: [
            { shaderLocation: 3, offset: 0, format: 'float32x2' },   // scale
          ],
        },
      ]
    },
    fragment: {
      module,
      entryPoint: 'fs',
      targets: [{ format: presentationFormat }],
    },
  });

  const kNumObjects = 100;
  const objectInfos = [];

  const staticUnitSize =
    4 +     // color is 4 bytes
    2 * 4;  // offset is 2 32bit floats (4bytes each)
  const changingUnitSize =
    2 * 4;  // scale is 2 32bit floats (4bytes each)
  const staticVertexBufferSize = staticUnitSize * kNumObjects;
  const changingVertexBufferSize = changingUnitSize * kNumObjects;

  const staticVertexBuffer = device.createBuffer({
    label: 'static vertex for objects',
    size: staticVertexBufferSize,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });

  const changingVertexBuffer = device.createBuffer({
    label: 'changing vertex for objects',
    size: changingVertexBufferSize,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });


  const kColorOffset = 0;
  const kOffsetOffset = 1;
  const kScaleOffset = 0;

  {
    const staticVertexValuesU8 = new Uint8Array(staticVertexBufferSize);
    const staticVertexValuesF32 = new Float32Array(staticVertexValuesU8.buffer);
    for (let i = 0; i < kNumObjects; ++i) {
      const staticOffsetU8 = i * staticUnitSize;
      const staticOffsetF32 = staticOffsetU8 / 4;

      // These are only set once so set them now
      staticVertexValuesU8.set(        // set the color
        [rand() * 255, rand() * 255, rand() * 255, 255],
        staticOffsetU8 + kColorOffset);

      staticVertexValuesF32.set(      // set the offset
        [rand(-0.9, 0.9), rand(-0.9, 0.9)],
        staticOffsetF32 + kOffsetOffset);

      objectInfos.push({
        scale: rand(0.2, 0.5),
      });
    }
    device.queue.writeBuffer(staticVertexBuffer, 0, staticVertexValuesF32);
  }

  const storageValues = new Float32Array(changingVertexBufferSize / 4);

  const { vertexData, indexData, numVertices } = createCircleVertices({
    radius: 0.5,
    innerRadius: 0.25,
  });


  const vertexBuffer = device.createBuffer({
    label: 'vertex buffer vertices',
    size: vertexData.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vertexBuffer, 0, vertexData);

  const indexBuffer = device.createBuffer({
    label: 'index buffer',
    size: indexData.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(indexBuffer, 0, indexData);

  const renderPassDescriptor = {
    label: 'our basic canvas renderPass',
    colorAttachments: [{
      clearValue: [0.3, 0.3, 0.3, 1],
      loadOp: 'clear',
      storeOp: 'store',
    }],
  };

  const observer = new ResizeObserver((entries) => {
    for (let entry of entries) {
      const canvas = entry.target;
      const width = entry.contentBoxSize[0].inlineSize;
      const height = entry.contentBoxSize[0].blockSize;
      canvas.width = Math.max(1, Math.min(width, device.limits.maxTextureDimension2D));
      canvas.height = Math.max(1, Math.min(height, device.limits.maxTextureDimension2D));
      render();
    }
  });

  observer.observe(canvas);

  function createCircleVertices({
    radius = 1,
    numSubdivisions = 24,
    innerRadius = 0,
    startAngle = 0,
    endAngle = Math.PI * 2,
  } = {}) {
    const numVertices = (numSubdivisions + 1) * 2;
    // 2 triangles per subdivision, 3 verts per tri, 2 values (xy) each.
    const vertexData = new Float32Array(numVertices * (2 + 1));
    const colorData = new Uint8Array(vertexData.buffer);

    let offset = 0;
    let colorOffset = 8;
    const addVertex = (x, y, r, g, b) => {
      vertexData[offset++] = x;
      vertexData[offset++] = y;
      offset += 1;  // skip the color
      colorData[colorOffset++] = r * 255;
      colorData[colorOffset++] = g * 255;
      colorData[colorOffset++] = b * 255;
      colorOffset += 9;  // skip extra byte and the position
    };

    const innerColor = [1, 1, 1];
    const outerColor = [0.1, 0.1, 0.1];

    for (let i = 0; i <= numSubdivisions; ++i) {
      const angle = startAngle + (i + 0) * (endAngle - startAngle) / numSubdivisions;

      const c1 = Math.cos(angle);
      const s1 = Math.sin(angle);

      addVertex(c1 * radius, s1 * radius, ...outerColor);
      addVertex(c1 * innerRadius, s1 * innerRadius, ...innerColor);
    }

    const indexData = new Uint32Array(numSubdivisions * 6);
    let ndx = 0;

    for (let i = 0; i < numSubdivisions; ++i) {
      const ndxOffset = i * 2;

      // first triangle
      indexData[ndx++] = ndxOffset;
      indexData[ndx++] = ndxOffset + 1;
      indexData[ndx++] = ndxOffset + 2;

      // second triangle
      indexData[ndx++] = ndxOffset + 2;
      indexData[ndx++] = ndxOffset + 1;
      indexData[ndx++] = ndxOffset + 3;
    }

    return {
      vertexData,
      indexData,
      numVertices: indexData.length,
    };
  }

  function fail(msg) {
    alert(msg);
  }

  function rand(min, max) {
    if (min === undefined) {
      min = 0;
      max = 1;
    } else if (max === undefined) {
      max = min;
      min = 0;
    }
    return min + Math.random() * (max - min);
  }

  function render() {
    renderPassDescriptor.colorAttachments[0].view = context.getCurrentTexture().createView();

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass(renderPassDescriptor);
    const aspect = canvas.width / canvas.height;

    pass.setPipeline(pipeline);
    pass.setVertexBuffer(0, vertexBuffer);
    pass.setVertexBuffer(1, staticVertexBuffer);
    pass.setVertexBuffer(2, changingVertexBuffer);
    pass.setIndexBuffer(indexBuffer, 'uint32');

    objectInfos.forEach(({ scale }, ndx) => {
      const offset = ndx * (changingUnitSize / 4);
      storageValues.set([scale / aspect, scale], offset + kScaleOffset);
    });
    device.queue.writeBuffer(changingVertexBuffer, 0, storageValues);
    pass.drawIndexed(numVertices, kNumObjects);
    pass.end();
    const commandBuffer = encoder.finish();
    device.queue.submit([commandBuffer]);
  }
}

main();
