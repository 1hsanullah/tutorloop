/**
 * The Python side of the grader. Evaluated once per Pyodide instance; `runPython` hands back
 * the `_run` function, which we then call per execution.
 *
 * Two things it does that a naive `exec` would not:
 *  - registers the learner's code and the test suite in `linecache` under stable virtual
 *    filenames, so tracebacks quote real source lines;
 *  - installs a tracing deadline, so an infinite loop raises inside the learner's frame instead
 *    of wedging the worker. `_Deadline` derives from BaseException so a bare `except Exception`
 *    in the learner's code cannot swallow it.
 */
export const PYTHON_DRIVER = String.raw`
import io, json, linecache, sys, time, traceback

_CODE_NAME = "<your code>"
_TEST_NAME = "<tests>"

class _Deadline(BaseException):
    pass

def _register(name, src):
    linecache.cache[name] = (len(src), None, src.splitlines(True), name)

def _tracer_factory(deadline):
    ticks = [0]
    def tracer(frame, event, arg):
        ticks[0] += 1
        if not (ticks[0] & 511) and time.monotonic() > deadline:
            raise _Deadline()
        return tracer
    return tracer

def _line_of(src, lineno):
    if not lineno:
        return None
    lines = src.splitlines()
    if 1 <= lineno <= len(lines):
        return lines[lineno - 1].strip()
    return None

def _deepest(frames, name):
    hit = None
    for frame in frames:
        if frame.filename == name:
            hit = frame.lineno
    return hit

def _only(exc):
    return "".join(traceback.format_exception_only(type(exc), exc)).strip()

def _describe(exc, code, tests):
    if isinstance(exc, SyntaxError) and exc.filename in (_CODE_NAME, _TEST_NAME):
        where = "tests" if exc.filename == _TEST_NAME else "code"
        src = tests if where == "tests" else code
        return {
            "kind": "syntax",
            "where": where,
            "message": _only(exc),
            "line": exc.lineno,
            "source": _line_of(src, exc.lineno),
            "testLine": exc.lineno if where == "tests" else None,
            "testSource": _line_of(tests, exc.lineno) if where == "tests" else None,
            "traceback": _only(exc),
        }

    frames = [f for f in traceback.extract_tb(exc.__traceback__)
              if f.filename in (_CODE_NAME, _TEST_NAME)]
    code_line = _deepest(frames, _CODE_NAME)
    test_line = _deepest(frames, _TEST_NAME)

    if isinstance(exc, _Deadline):
        kind = "timeout"
        message = "Timed out: your code ran longer than the time limit. Look for a loop that never ends."
    elif isinstance(exc, AssertionError):
        kind = "assertion"
        message = _only(exc)
        if message == "AssertionError":
            message = "Assertion failed."
    else:
        kind = "error"
        message = _only(exc)

    if kind == "assertion" and code_line is None and test_line is not None:
        where, line = "tests", test_line
    elif code_line is not None:
        where, line = "code", code_line
    elif test_line is not None:
        where, line = "tests", test_line
    else:
        where, line = "code", None

    src = tests if where == "tests" else code
    if frames:
        rendered = ["Traceback (most recent call last):\n"] + traceback.format_list(frames) + [_only(exc)]
    else:
        rendered = [_only(exc)]

    return {
        "kind": kind,
        "where": where,
        "message": message,
        "line": line,
        "source": _line_of(src, line),
        "testLine": test_line,
        "testSource": _line_of(tests, test_line),
        "traceback": "".join(rendered).strip(),
    }

def _run(code, tests, mode, timeout):
    _register(_CODE_NAME, code)
    _register(_TEST_NAME, tests)
    out, err = io.StringIO(), io.StringIO()
    result = {"stdout": "", "stderr": "", "passed": None, "failure": None}
    saved = (sys.stdout, sys.stderr)
    sys.stdout, sys.stderr = out, err
    namespace = {"__name__": "__main__"}
    sys.settrace(_tracer_factory(time.monotonic() + timeout))
    try:
        exec(compile(code, _CODE_NAME, "exec"), namespace)
        if mode == "submit":
            exec(compile(tests, _TEST_NAME, "exec"), namespace)
            result["passed"] = True
    except BaseException as exc:
        sys.settrace(None)
        result["failure"] = _describe(exc, code, tests)
        if mode == "submit":
            result["passed"] = False
    finally:
        sys.settrace(None)
        sys.stdout, sys.stderr = saved
    result["stdout"] = out.getvalue()
    result["stderr"] = err.getvalue()
    return json.dumps(result)

_run
`;
