class OfflinePanoramaViewer {
    constructor(canvas) {
        this.canvas = canvas;
        this.gl = canvas.getContext('webgl', { antialias: true });
        if (!this.gl) {
            throw new Error('This browser does not support WebGL for panorama viewing.');
        }

        this.yaw = 0;
        this.pitch = 0;
        this.fieldOfView = Math.PI / 2;
        this.baseBearing = 0;
        this.texture = null;
        this.image = null;
        this.dragPosition = null;
        this.bearingChangeHandler = () => {};
        this.program = this.createProgram();
        this.positionAttribute = this.gl.getAttribLocation(this.program, 'a_position');
        this.textureUniform = this.gl.getUniformLocation(this.program, 'u_texture');
        this.resolutionUniform = this.gl.getUniformLocation(this.program, 'u_resolution');
        this.yawUniform = this.gl.getUniformLocation(this.program, 'u_yaw');
        this.pitchUniform = this.gl.getUniformLocation(this.program, 'u_pitch');
        this.fovUniform = this.gl.getUniformLocation(this.program, 'u_fov');
        this.buffer = this.gl.createBuffer();

        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffer);
        this.gl.bufferData(
            this.gl.ARRAY_BUFFER,
            new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
            this.gl.STATIC_DRAW
        );

        canvas.addEventListener('pointerdown', event => {
            this.dragPosition = { x: event.clientX, y: event.clientY };
            canvas.setPointerCapture(event.pointerId);
        });
        canvas.addEventListener('pointermove', event => {
            if (!this.dragPosition) return;
            const deltaX = event.clientX - this.dragPosition.x;
            const deltaY = event.clientY - this.dragPosition.y;
            this.dragPosition = { x: event.clientX, y: event.clientY };
            this.yaw -= deltaX * 0.004;
            this.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.pitch + deltaY * 0.004));
            this.render();
            this.bearingChangeHandler(this.getBearing());
        });
        const stopDrag = () => {
            this.dragPosition = null;
        };
        canvas.addEventListener('pointerup', stopDrag);
        canvas.addEventListener('pointercancel', stopDrag);
        canvas.addEventListener('wheel', event => {
            event.preventDefault();
            this.fieldOfView = Math.max(
                Math.PI / 6,
                Math.min(Math.PI * 0.8, this.fieldOfView + event.deltaY * 0.001)
            );
            this.render();
        }, { passive: false });
        window.addEventListener('resize', () => this.resize());
        this.resize();
    }

    createProgram() {
        const vertexSource = `
            attribute vec2 a_position;
            varying vec2 v_uv;
            void main() {
                v_uv = a_position * 0.5 + 0.5;
                gl_Position = vec4(a_position, 0.0, 1.0);
            }
        `;
        const fragmentSource = `
            precision highp float;
            varying vec2 v_uv;
            uniform sampler2D u_texture;
            uniform vec2 u_resolution;
            uniform float u_yaw;
            uniform float u_pitch;
            uniform float u_fov;
            const float PI = 3.141592653589793;
            void main() {
                float scale = tan(u_fov * 0.5);
                vec3 direction = normalize(vec3(
                    (v_uv.x * 2.0 - 1.0) * (u_resolution.x / u_resolution.y) * scale,
                    (1.0 - v_uv.y * 2.0) * scale,
                    1.0
                ));
                float pitchCos = cos(u_pitch);
                float pitchSin = sin(u_pitch);
                direction = vec3(
                    direction.x,
                    direction.y * pitchCos - direction.z * pitchSin,
                    direction.y * pitchSin + direction.z * pitchCos
                );
                float yawCos = cos(u_yaw);
                float yawSin = sin(u_yaw);
                direction = vec3(
                    direction.x * yawCos + direction.z * yawSin,
                    direction.y,
                    -direction.x * yawSin + direction.z * yawCos
                );
                vec2 panoramaUv = vec2(
                    fract(atan(direction.x, direction.z) / (2.0 * PI) + 0.5),
                    0.5 - asin(clamp(direction.y, -1.0, 1.0)) / PI
                );
                gl_FragColor = texture2D(u_texture, panoramaUv);
            }
        `;
        const gl = this.gl;
        const compile = (type, source) => {
            const shader = gl.createShader(type);
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                const error = gl.getShaderInfoLog(shader);
                gl.deleteShader(shader);
                throw new Error(`Could not initialize panorama renderer: ${error}`);
            }
            return shader;
        };
        const program = gl.createProgram();
        gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource));
        gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            throw new Error(`Could not link panorama renderer: ${gl.getProgramInfoLog(program)}`);
        }
        return program;
    }

    async loadImage(record) {
        const image = new Image();
        image.src = record.image_url;
        try {
            await image.decode();
        } catch (error) {
            throw new Error(`Could not load local panorama ${record.id}: ${error.message}`);
        }
        this.image = image;
        this.yaw = 0;
        this.pitch = 0;
        if (this.texture) this.gl.deleteTexture(this.texture);
        this.texture = this.gl.createTexture();
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.texture);
        this.gl.pixelStorei(this.gl.UNPACK_FLIP_Y_WEBGL, true);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
        this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, image);
        this.render();
    }

    onBearingChange(handler) {
        this.bearingChangeHandler = handler;
    }

    getBearing() {
        return (this.baseBearing + this.yaw * 180 / Math.PI + 360) % 360;
    }

    setBaseBearing(bearing) {
        this.baseBearing = Number.isFinite(bearing) ? bearing : 0;
        this.bearingChangeHandler(this.getBearing());
    }

    resize() {
        const ratio = window.devicePixelRatio || 1;
        const width = Math.max(1, Math.round(this.canvas.clientWidth * ratio));
        const height = Math.max(1, Math.round(this.canvas.clientHeight * ratio));
        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width;
            this.canvas.height = height;
        }
        this.gl.viewport(0, 0, width, height);
        this.render();
    }

    render() {
        if (!this.gl || !this.program) return;
        const gl = this.gl;
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.clearColor(0.05, 0.05, 0.05, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        if (!this.texture) return;

        gl.useProgram(this.program);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.enableVertexAttribArray(this.positionAttribute);
        gl.vertexAttribPointer(this.positionAttribute, 2, gl.FLOAT, false, 0, 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.uniform1i(this.textureUniform, 0);
        gl.uniform2f(this.resolutionUniform, this.canvas.width, this.canvas.height);
        gl.uniform1f(this.yawUniform, this.yaw);
        gl.uniform1f(this.pitchUniform, this.pitch);
        gl.uniform1f(this.fovUniform, this.fieldOfView);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
}
