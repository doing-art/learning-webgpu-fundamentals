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
      
      @group(0) @binding(0) var<storage, read> ourStruct: array<OurStruct>;
      @group(0) @binding(1) var<storage, read> otherStruct: array<OtherStruct>;
      @group(0) @binding(2) var<storage, read> pos: array<vec2f>;
    
      @vertex 
      fn vs(
        @builtin(vertex_index) vertexIndex: u32,
        @builtin(instance_index) instanceIndex: u32
      ) -> VSOutput {
        let otherStruct = otherStruct[instanceIndex];
        let ourStruct = ourStruct[instanceIndex];
        
        var vsOut: VSOutput;
        vsOut.position = vec4f(pos[vertexIndex] * otherStruct.scale + ourStruct.offset, 0.0, 1.0);
        vsOut.color = ourStruct.color;
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
    },
    fragment: {
      module,
      entryPoint: 'fs',
      targets: [{ format: presentationFormat }],
    },
  });

  const staticUnitSize =
    4 * 4 + // color is 4 32bit floats (4bytes each)
    2 * 4 + // offset is 2 32bit floats (4bytes each)
    2 * 4;  // padding
  const changingUnitSize =
    2 * 4;  // scale is 2 32bit floats (4bytes each)

  const kNumObjects = 100;
  const objectInfos = [];

  const staticStorageBufferSize = staticUnitSize * kNumObjects;
  const changingStorageBufferSize = changingUnitSize * kNumObjects;

  const staticStorageBuffer = device.createBuffer({
    label: 'static storage for objects',
    size: staticStorageBufferSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  const changingStorageBuffer = device.createBuffer({
    label: 'changing storage for objects',
    size: staticStorageBufferSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });


  const kColorOffset = 0;
  const kOffsetOffset = 4;
  const kScaleOffset = 0;

  {
    const staticStorageValues = new Float32Array(staticStorageBufferSize / 4);
    for (let i = 0; i < kNumObjects; ++i) {
      const staticOffset = i * (staticUnitSize / 4);

      // These are only set once so set them now
      staticStorageValues.set([rand(), rand(), rand(), 1], staticOffset + kColorOffset);        // set the color
      staticStorageValues.set([rand(-0.9, 0.9), rand(-0.9, 0.9)], staticOffset + kOffsetOffset);      // set the offset

      objectInfos.push({
        scale: rand(0.2, 0.5),
      });
    }
    device.queue.writeBuffer(staticStorageBuffer, 0, staticStorageValues);
  }

  const storageValues = new Float32Array(changingStorageBufferSize / 4);

  const { vertexData, numVertices } = createCircleVertices({
    radius: 0.5,
    innerRadius: 0.25,
  });

  const vertexStorageBuffer = device.createBuffer({
    label: 'storage buffer vertices',
    size: vertexData.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  device.queue.writeBuffer(vertexStorageBuffer, 0, vertexData);

  const bindGroup = device.createBindGroup({
    label: 'bind group for objects',
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: staticStorageBuffer }},
      { binding: 1, resource: { buffer: changingStorageBuffer }},
      { binding: 2, resource: { buffer: vertexStorageBuffer }},
    ],
  });


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
    // 2 triangles per subdivision, 3 verts per tri, 2 values (xy) each.
    const numVertices = numSubdivisions * 3 * 2;
    const vertexData = new Float32Array(numSubdivisions * 2 * 3 * 2);

    let offset = 0;
    const addVertex = (x, y) => {
      vertexData[offset++] = x;
      vertexData[offset++] = y;
    };

    // 2 triangles per subdivision
    //
    // 0--1 4
    // | / /|
    // |/ / |
    // 2 3--5
    for (let i = 0; i < numSubdivisions; ++i) {
      const angle1 = startAngle + (i + 0) * (endAngle - startAngle) / numSubdivisions;
      const angle2 = startAngle + (i + 1) * (endAngle - startAngle) / numSubdivisions;

      const c1 = Math.cos(angle1);
      const s1 = Math.sin(angle1);
      const c2 = Math.cos(angle2);
      const s2 = Math.sin(angle2);

      // first triangle
      addVertex(c1 * radius, s1 * radius);
      addVertex(c2 * radius, s2 * radius);
      addVertex(c1 * innerRadius, s1 * innerRadius);

      // second triangle
      addVertex(c1 * innerRadius, s1 * innerRadius);
      addVertex(c2 * radius, s2 * radius);
      addVertex(c2 * innerRadius, s2 * innerRadius);
    }

    return {
      vertexData,
      numVertices,
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

    objectInfos.forEach(({ scale }, ndx) => {
      const offset = ndx * (changingUnitSize / 4);
      storageValues.set([scale / aspect, scale], offset + kScaleOffset);
    });
    device.queue.writeBuffer(changingStorageBuffer, 0, storageValues);
    pass.setBindGroup(0, bindGroup);
    pass.draw(numVertices, kNumObjects);
    pass.end();
    const commandBuffer = encoder.finish();
    device.queue.submit([commandBuffer]);
  }
}

main();
