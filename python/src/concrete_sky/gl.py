"""Thin helpers over PyOpenGL: shader programs, meshes, textures, framebuffers."""

from __future__ import annotations

import ctypes

import numpy as np
from OpenGL import GL as gl

GL_TEXTURE_MAX_ANISOTROPY = 0x84FE


class ShaderError(RuntimeError):
    pass


def _compile(kind: int, source: str) -> int:
    shader = gl.glCreateShader(kind)
    gl.glShaderSource(shader, source)
    gl.glCompileShader(shader)
    if not gl.glGetShaderiv(shader, gl.GL_COMPILE_STATUS):
        log = gl.glGetShaderInfoLog(shader).decode(errors="replace")
        numbered = "\n".join(f"{i + 1:4d} {line}" for i, line in enumerate(source.splitlines()))
        raise ShaderError(f"shader compile failed:\n{log}\n{numbered}")
    return shader


class Program:
    def __init__(self, vertex: str, fragment: str):
        vs = _compile(gl.GL_VERTEX_SHADER, vertex)
        fs = _compile(gl.GL_FRAGMENT_SHADER, fragment)
        self.id = gl.glCreateProgram()
        gl.glAttachShader(self.id, vs)
        gl.glAttachShader(self.id, fs)
        gl.glLinkProgram(self.id)
        if not gl.glGetProgramiv(self.id, gl.GL_LINK_STATUS):
            raise ShaderError(gl.glGetProgramInfoLog(self.id).decode(errors="replace"))
        gl.glDeleteShader(vs)
        gl.glDeleteShader(fs)
        self._locs: dict[str, int] = {}

    def use(self) -> None:
        gl.glUseProgram(self.id)

    def loc(self, name: str) -> int:
        loc = self._locs.get(name)
        if loc is None:
            loc = gl.glGetUniformLocation(self.id, name)
            self._locs[name] = loc
        return loc

    def set(self, name: str, value) -> None:
        loc = self.loc(name)
        if loc < 0:
            return
        if isinstance(value, (int, np.integer)) and not isinstance(value, bool):
            gl.glUniform1i(loc, int(value))
            return
        if isinstance(value, (float, np.floating, bool)):
            gl.glUniform1f(loc, float(value))
            return
        arr = np.asarray(value, dtype=np.float32)
        if arr.shape == (4, 4):
            gl.glUniformMatrix4fv(loc, 1, gl.GL_TRUE, arr)
        elif arr.shape == (2,):
            gl.glUniform2f(loc, *arr)
        elif arr.shape == (3,):
            gl.glUniform3f(loc, *arr)
        elif arr.shape == (4,):
            gl.glUniform4f(loc, *arr)
        else:
            raise ValueError(f"unsupported uniform shape {arr.shape} for {name}")

    def set_many(self, values: dict) -> None:
        for k, v in values.items():
            self.set(k, v)


class Mesh:
    """Interleaved float32 vertex buffer with optional uint32 index buffer."""

    def __init__(self, vertices: np.ndarray, layout: list[int], indices: np.ndarray | None = None,
                 mode: int = gl.GL_TRIANGLES):
        vertices = np.ascontiguousarray(vertices, dtype=np.float32)
        self.mode = mode
        self.vao = gl.glGenVertexArrays(1)
        gl.glBindVertexArray(self.vao)
        self.vbo = gl.glGenBuffers(1)
        gl.glBindBuffer(gl.GL_ARRAY_BUFFER, self.vbo)
        gl.glBufferData(gl.GL_ARRAY_BUFFER, vertices.nbytes, vertices, gl.GL_STATIC_DRAW)
        stride = sum(layout) * 4
        offset = 0
        for loc, size in enumerate(layout):
            gl.glEnableVertexAttribArray(loc)
            gl.glVertexAttribPointer(loc, size, gl.GL_FLOAT, gl.GL_FALSE, stride, ctypes.c_void_p(offset))
            offset += size * 4
        self.ebo = None
        if indices is not None:
            indices = np.ascontiguousarray(indices, dtype=np.uint32)
            self.ebo = gl.glGenBuffers(1)
            gl.glBindBuffer(gl.GL_ELEMENT_ARRAY_BUFFER, self.ebo)
            gl.glBufferData(gl.GL_ELEMENT_ARRAY_BUFFER, indices.nbytes, indices, gl.GL_STATIC_DRAW)
            self.count = len(indices)
        else:
            self.count = len(vertices) // (stride // 4) if vertices.ndim == 1 else len(vertices)
        gl.glBindVertexArray(0)

    def draw(self) -> None:
        gl.glBindVertexArray(self.vao)
        if self.ebo is not None:
            gl.glDrawElements(self.mode, self.count, gl.GL_UNSIGNED_INT, None)
        else:
            gl.glDrawArrays(self.mode, 0, self.count)

    def delete(self) -> None:
        bufs = [self.vbo] + ([self.ebo] if self.ebo is not None else [])
        gl.glDeleteBuffers(len(bufs), bufs)
        gl.glDeleteVertexArrays(1, [self.vao])


def fullscreen_triangle() -> Mesh:
    verts = np.array([[-1, -1], [3, -1], [-1, 3]], dtype=np.float32)
    return Mesh(verts, [2])


def texture_2d(data: np.ndarray, srgb: bool = False, mipmaps: bool = True, repeat: bool = True) -> int:
    """data: (h, w, 4) uint8. Row 0 is the bottom (v = 0)."""
    h, w = data.shape[:2]
    tex = gl.glGenTextures(1)
    gl.glBindTexture(gl.GL_TEXTURE_2D, tex)
    fmt = gl.GL_SRGB8_ALPHA8 if srgb else gl.GL_RGBA8
    gl.glTexImage2D(gl.GL_TEXTURE_2D, 0, fmt, w, h, 0, gl.GL_RGBA, gl.GL_UNSIGNED_BYTE,
                    np.ascontiguousarray(data, dtype=np.uint8))
    wrap = gl.GL_REPEAT if repeat else gl.GL_CLAMP_TO_EDGE
    gl.glTexParameteri(gl.GL_TEXTURE_2D, gl.GL_TEXTURE_WRAP_S, wrap)
    gl.glTexParameteri(gl.GL_TEXTURE_2D, gl.GL_TEXTURE_WRAP_T, wrap)
    gl.glTexParameteri(gl.GL_TEXTURE_2D, gl.GL_TEXTURE_MAG_FILTER, gl.GL_LINEAR)
    if mipmaps:
        gl.glTexParameteri(gl.GL_TEXTURE_2D, gl.GL_TEXTURE_MIN_FILTER, gl.GL_LINEAR_MIPMAP_LINEAR)
        gl.glGenerateMipmap(gl.GL_TEXTURE_2D)
    else:
        gl.glTexParameteri(gl.GL_TEXTURE_2D, gl.GL_TEXTURE_MIN_FILTER, gl.GL_LINEAR)
    return tex


def texture_array(layers: np.ndarray, srgb: bool) -> int:
    """layers: (n, h, w, 4) uint8."""
    n, h, w = layers.shape[:3]
    tex = gl.glGenTextures(1)
    gl.glBindTexture(gl.GL_TEXTURE_2D_ARRAY, tex)
    fmt = gl.GL_SRGB8_ALPHA8 if srgb else gl.GL_RGBA8
    gl.glTexImage3D(gl.GL_TEXTURE_2D_ARRAY, 0, fmt, w, h, n, 0, gl.GL_RGBA, gl.GL_UNSIGNED_BYTE,
                    np.ascontiguousarray(layers, dtype=np.uint8))
    gl.glTexParameteri(gl.GL_TEXTURE_2D_ARRAY, gl.GL_TEXTURE_WRAP_S, gl.GL_REPEAT)
    gl.glTexParameteri(gl.GL_TEXTURE_2D_ARRAY, gl.GL_TEXTURE_WRAP_T, gl.GL_REPEAT)
    gl.glTexParameteri(gl.GL_TEXTURE_2D_ARRAY, gl.GL_TEXTURE_MAG_FILTER, gl.GL_LINEAR)
    gl.glTexParameteri(gl.GL_TEXTURE_2D_ARRAY, gl.GL_TEXTURE_MIN_FILTER, gl.GL_LINEAR_MIPMAP_LINEAR)
    try:
        gl.glTexParameterf(gl.GL_TEXTURE_2D_ARRAY, GL_TEXTURE_MAX_ANISOTROPY, 8.0)
    except gl.GLError:
        pass
    gl.glGenerateMipmap(gl.GL_TEXTURE_2D_ARRAY)
    return tex


class Framebuffer:
    """HDR color target (with mip chain for cheap bloom) plus depth."""

    def __init__(self, width: int, height: int):
        self.width, self.height = width, height
        self.levels = int(np.floor(np.log2(max(width, height)))) + 1
        self.fbo = gl.glGenFramebuffers(1)
        gl.glBindFramebuffer(gl.GL_FRAMEBUFFER, self.fbo)

        self.color = gl.glGenTextures(1)
        gl.glBindTexture(gl.GL_TEXTURE_2D, self.color)
        gl.glTexStorage2D(gl.GL_TEXTURE_2D, self.levels, gl.GL_RGBA16F, width, height)
        gl.glTexParameteri(gl.GL_TEXTURE_2D, gl.GL_TEXTURE_MIN_FILTER, gl.GL_LINEAR_MIPMAP_LINEAR)
        gl.glTexParameteri(gl.GL_TEXTURE_2D, gl.GL_TEXTURE_MAG_FILTER, gl.GL_LINEAR)
        gl.glTexParameteri(gl.GL_TEXTURE_2D, gl.GL_TEXTURE_WRAP_S, gl.GL_CLAMP_TO_EDGE)
        gl.glTexParameteri(gl.GL_TEXTURE_2D, gl.GL_TEXTURE_WRAP_T, gl.GL_CLAMP_TO_EDGE)
        gl.glFramebufferTexture2D(gl.GL_FRAMEBUFFER, gl.GL_COLOR_ATTACHMENT0, gl.GL_TEXTURE_2D, self.color, 0)

        self.depth = gl.glGenRenderbuffers(1)
        gl.glBindRenderbuffer(gl.GL_RENDERBUFFER, self.depth)
        gl.glRenderbufferStorage(gl.GL_RENDERBUFFER, gl.GL_DEPTH_COMPONENT32F, width, height)
        gl.glFramebufferRenderbuffer(gl.GL_FRAMEBUFFER, gl.GL_DEPTH_ATTACHMENT, gl.GL_RENDERBUFFER, self.depth)
        _check_fbo()
        gl.glBindFramebuffer(gl.GL_FRAMEBUFFER, 0)

    def bind(self) -> None:
        gl.glBindFramebuffer(gl.GL_FRAMEBUFFER, self.fbo)
        gl.glViewport(0, 0, self.width, self.height)

    def build_mips(self) -> None:
        gl.glBindTexture(gl.GL_TEXTURE_2D, self.color)
        gl.glGenerateMipmap(gl.GL_TEXTURE_2D)


class ShadowMap:
    def __init__(self, size: int):
        self.size = size
        self.fbo = gl.glGenFramebuffers(1)
        gl.glBindFramebuffer(gl.GL_FRAMEBUFFER, self.fbo)
        self.depth = gl.glGenTextures(1)
        gl.glBindTexture(gl.GL_TEXTURE_2D, self.depth)
        gl.glTexImage2D(gl.GL_TEXTURE_2D, 0, gl.GL_DEPTH_COMPONENT24, size, size, 0,
                        gl.GL_DEPTH_COMPONENT, gl.GL_FLOAT, None)
        gl.glTexParameteri(gl.GL_TEXTURE_2D, gl.GL_TEXTURE_MIN_FILTER, gl.GL_LINEAR)
        gl.glTexParameteri(gl.GL_TEXTURE_2D, gl.GL_TEXTURE_MAG_FILTER, gl.GL_LINEAR)
        gl.glTexParameteri(gl.GL_TEXTURE_2D, gl.GL_TEXTURE_WRAP_S, gl.GL_CLAMP_TO_BORDER)
        gl.glTexParameteri(gl.GL_TEXTURE_2D, gl.GL_TEXTURE_WRAP_T, gl.GL_CLAMP_TO_BORDER)
        gl.glTexParameterfv(gl.GL_TEXTURE_2D, gl.GL_TEXTURE_BORDER_COLOR, [1.0, 1.0, 1.0, 1.0])
        gl.glTexParameteri(gl.GL_TEXTURE_2D, gl.GL_TEXTURE_COMPARE_MODE, gl.GL_COMPARE_REF_TO_TEXTURE)
        gl.glTexParameteri(gl.GL_TEXTURE_2D, gl.GL_TEXTURE_COMPARE_FUNC, gl.GL_LEQUAL)
        gl.glFramebufferTexture2D(gl.GL_FRAMEBUFFER, gl.GL_DEPTH_ATTACHMENT, gl.GL_TEXTURE_2D, self.depth, 0)
        gl.glDrawBuffer(gl.GL_NONE)
        gl.glReadBuffer(gl.GL_NONE)
        _check_fbo()
        gl.glBindFramebuffer(gl.GL_FRAMEBUFFER, 0)

    def bind(self) -> None:
        gl.glBindFramebuffer(gl.GL_FRAMEBUFFER, self.fbo)
        gl.glViewport(0, 0, self.size, self.size)


def _check_fbo() -> None:
    status = gl.glCheckFramebufferStatus(gl.GL_FRAMEBUFFER)
    if status != gl.GL_FRAMEBUFFER_COMPLETE:
        raise RuntimeError(f"framebuffer incomplete: 0x{status:x}")


def bind_texture(unit: int, tex: int, target: int = gl.GL_TEXTURE_2D) -> None:
    gl.glActiveTexture(gl.GL_TEXTURE0 + unit)
    gl.glBindTexture(target, tex)
