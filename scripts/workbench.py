#!/usr/bin/env python3
"""Inspect ComfyUI API graphs and render a single-file workbench with verified bindings."""

import argparse
import hashlib
import html
import json
import math
import re
from pathlib import Path
from urllib.parse import quote

ASSETS = Path(__file__).resolve().parents[1] / "assets"


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def load_graph(path):
    data = read_json(path)
    if not isinstance(data, dict):
        raise ValueError("Expected a ComfyUI API JSON object.")
    if isinstance(data.get("nodes"), list):
        raise ValueError(
            "This is a ComfyUI editor workflow. Export the workflow in API format."
        )
    graph = data.get("prompt", data)
    if (
        not isinstance(graph, dict)
        or not graph
        or not all(
            isinstance(node, dict)
            and isinstance(node.get("class_type"), str)
            and isinstance(node.get("inputs"), dict)
            for node in graph.values()
        )
    ):
        raise ValueError(
            "Expected an API node map with class_type and inputs, optionally under prompt."
        )
    return graph


def safe_json(value):
    # Prevent literal closing script tags, including strings in prompts and node metadata.
    return (
        json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2)
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("&", "\\u0026")
    )


def is_number(value):
    return type(value) in (int, float) and math.isfinite(value)


def inspect_graph(graph):
    for node_id, node in graph.items():
        metadata = node.get("_meta", {})
        title = metadata.get("title") if isinstance(metadata, dict) else None
        print(f"{node_id}  {node['class_type']}" + (f"  ({title!r})" if title else ""))
        for name, value in node["inputs"].items():
            if (
                isinstance(value, list)
                and len(value) == 2
                and isinstance(value[0], str)
                and value[0] in graph
            ):
                print(f"  {name} <- {value[0]}[{value[1]}]")
            else:
                text = repr(value)
                print(f"  {name} = {text[:215]}{'…' if len(text) > 215 else ''}")


def validate_profile(graph, profile):
    if not isinstance(profile, dict):
        raise ValueError("The profile must be a JSON object.")

    def field(pair, label, predicate, *, require_reachable=True):
        if not (
            isinstance(pair, list)
            and len(pair) == 2
            and all(isinstance(part, str) for part in pair)
            and pair[0] in graph
            and pair[1] in graph[pair[0]]["inputs"]
        ):
            raise ValueError(f"{label} must name an existing [node ID, input key].")
        if require_reachable and pair[0] not in reachable:
            raise ValueError(f"{label} must belong to an output branch.")
        value = graph[pair[0]]["inputs"][pair[1]]
        if not predicate(value):
            raise ValueError(f"{label} does not match the node's input type.")
        return value

    def slider(config, label, value):
        low, high = config.get("min"), config.get("max")
        increment = config.get("increment", 1)
        if not (
            all(is_number(x) for x in (low, high, value, increment))
            and low < high
            and low <= value <= high
            and increment > 0
        ):
            raise ValueError(f"{label} needs bounds containing the original value.")
        if not math.isclose(
            (value - low) / increment, round((value - low) / increment), abs_tol=1e-7
        ):
            raise ValueError(
                f"{label} bounds and increment must preserve the original value."
            )

    outputs = profile.get("outputs")
    if (
        not isinstance(outputs, list)
        or not outputs
        or not all(isinstance(node, str) and node in graph for node in outputs)
        or len(set(outputs)) != len(outputs)
    ):
        raise ValueError(
            "outputs must contain distinct existing terminal output node IDs."
        )
    reachable = set()
    waiting = list(outputs)
    while waiting:
        node = waiting.pop()
        if node in reachable:
            continue
        reachable.add(node)
        for value in graph[node]["inputs"].values():
            if (
                isinstance(value, list)
                and len(value) == 2
                and isinstance(value[0], str)
                and value[0] in graph
                and type(value[1]) is int
            ):
                waiting.append(value[0])
    if "prompt" in profile:
        field(profile["prompt"], "prompt", lambda x: isinstance(x, str))
    if "seed" in profile:
        field(profile["seed"], "seed", lambda x: type(x) is int)
    if "sampler" in profile and profile["sampler"] not in graph:
        raise ValueError("sampler must name an existing node.")
    for pair in profile.get("matchIgnore", []):
        field(pair, "matchIgnore field", lambda _: True)

    fps = profile.get("fps")
    if fps is not None and not (is_number(fps) and fps > 0):
        raise ValueError("fps must be a positive number.")
    duration = profile.get("duration")
    if duration:
        value = field(duration.get("field"), "duration.field", is_number)
        slider(duration, "duration", value)
        if duration["min"] <= 0:
            raise ValueError("duration bounds must be positive.")
        if duration.get("unit") == "frames" and not (
            fps
            and type(value) is int
            and all(type(duration.get(k, 1)) is int for k in ("min", "max", "increment"))
        ):
            raise ValueError("Frame durations need integer bounds, increment and value, and a positive fps.")
        alignment = duration.get("alignment")
        if alignment and not (
            fps
            and all(
                type(alignment.get(k)) is int and alignment[k] > 0
                for k in ("base", "period")
            )
        ):
            raise ValueError(
                "Frame alignment needs verified positive integer base and period and a positive fps."
            )

    steps = profile.get("steps")
    if steps:
        mode = steps.get("mode")
        if mode == "integer":
            value = field(steps.get("field"), "steps.field", lambda x: type(x) is int)
        elif mode == "sigmas":
            raw = field(steps.get("field"), "steps.field", lambda x: isinstance(x, str))
            values = [float(part.strip()) for part in raw.split(",")]
            if len(values) < 2 or not all(is_number(part) for part in values):
                raise ValueError("A sigma schedule needs at least two finite values.")
            value = len(values) - 1
        else:
            raise ValueError("steps.mode must be integer or sigmas.")
        if not all(
            type(steps.get(k, 1)) is int and steps.get(k, 1) > 0
            for k in ("min", "max", "increment")
        ):
            raise ValueError(
                "Sampling step bounds and increment must be positive integers."
            )
        slider(steps, "steps", value)

    size = profile.get("size")
    if size:
        if size.get("mode") == "selector":
            value = field(size.get("ratio"), "size.ratio", lambda x: isinstance(x, str))
            field(
                size.get("megapixels"),
                "size.megapixels",
                lambda x: is_number(x) and x > 0,
            )
            ratios = size.get("ratios", {})
            if (
                not isinstance(ratios, dict)
                or value not in ratios.values()
                or not all(
                    re.fullmatch(r"[1-9]\d*:[1-9]\d*", key) and isinstance(label, str)
                    for key, label in ratios.items()
                )
            ):
                raise ValueError(
                    "size.ratios must include the selector's original aspect ratio literal."
                )
            values = size.get("megapixelsOptions")
            if not isinstance(values, list) or not all(
                is_number(x) and x > 0 for x in values
            ):
                raise ValueError(
                    "size.megapixelsOptions must be a list of verified positive values."
                )
            common = size.get("commonMegapixels", [])
            original_mp = graph[size["megapixels"][0]]["inputs"][size["megapixels"][1]]
            if not isinstance(common, list) or not all(
                is_number(x) and x in values + [original_mp] for x in common
            ):
                raise ValueError(
                    "commonMegapixels must use available megapixel values."
                )
            if type(size.get("multiple")) is not int or size["multiple"] < 1:
                raise ValueError(
                    "size.multiple must equal the selector's positive alignment multiple."
                )
        elif size.get("mode") == "preset":
            for name in ("width", "height"):
                field(
                    size.get(name), f"size.{name}", lambda x: type(x) is int and x > 0
                )
            for preset in size.get("presets", []):
                if not (
                    isinstance(preset, list)
                    and len(preset) == 2
                    and all(type(x) is int and x > 0 for x in preset)
                ):
                    raise ValueError(
                        "Direct size presets must be positive integer [width, height] pairs."
                    )
        else:
            raise ValueError("size.mode must be selector or preset.")

    tags = profile.get("referenceTags", {})
    if not isinstance(tags, dict) or any(
        kind not in ("image", "video", "audio") for kind in tags
    ):
        raise ValueError("referenceTags accepts image, video, and audio keys.")
    for tag in [profile.get("referenceTag"), *tags.values()]:
        if tag is not None and (
            not isinstance(tag, str)
            or not re.fullmatch(r"[A-Za-z][A-Za-z0-9 _-]*", tag)
        ):
            raise ValueError(
                "Reference tags accept plain names such as Picture, Video, or Audio."
            )
    h3 = profile.get("h3ReferenceNode")
    if h3 is not None and (
        h3 not in reachable or graph[h3]["class_type"] != "MiniMaxH3ReferenceToVideo"
    ):
        raise ValueError(
            "h3ReferenceNode must identify a connected MiniMaxH3ReferenceToVideo node."
        )
    slots = profile.get("references", [])
    if not isinstance(slots, list):
        raise ValueError("references must be an array in workflow slot order.")
    loaders = set()
    claimed = set()
    for slot in slots:
        if slot.get("kind", "image") not in ("image", "video", "audio"):
            raise ValueError("reference.kind must be image, video, or audio.")
        if type(slot.get("required", False)) is not bool:
            raise ValueError("reference.required must be a boolean.")
        pair = slot.get("file")
        field(pair, "reference file", lambda x: isinstance(x, str))
        if pair[0] in loaders:
            raise ValueError("Give each reference slot its own file loader.")
        loaders.add(pair[0])
        targets = slot.get("targets", [])
        if not targets:
            raise ValueError("Each reference slot needs a downstream link.")
        for target in targets:
            field(
                target,
                "reference target",
                lambda x: isinstance(x, list) and len(x) == 2 and x[0] == pair[0],
            )
            if tuple(target) in claimed:
                raise ValueError("A reference target belongs to only one slot.")
            claimed.add(tuple(target))
    advanced = profile.get("advanced", [])
    if not isinstance(advanced, list):
        raise ValueError("advanced must contain a list of node field definitions.")
    standard_fields = {
        tuple(pair)
        for pair in (
            profile.get("prompt"),
            (profile.get("steps") or {}).get("field"),
            (profile.get("duration") or {}).get("field"),
            *(
                size[key]
                for key in ("ratio", "megapixels", "width", "height")
                if size and key in size
            ),
            *(slot["file"] for slot in slots),
        )
        if pair
    }

    def numeric_widget(value):
        return is_number(value) and (
            not float(value).is_integer() or abs(value) < 2**53
        )

    def widget_type(value):
        if numeric_widget(value):
            return "number"
        if type(value) is bool:
            return "boolean"
        if type(value) is str:
            return "text"

    seen_advanced = set()
    for definition in advanced:
        if not isinstance(definition, dict):
            raise ValueError("Each advanced field needs an object definition.")
        pair = definition.get("field")
        original = field(
            pair,
            "advanced field",
            lambda value: widget_type(value) is not None,
            require_reachable=False,
        )
        key = tuple(pair)
        if key in standard_fields or key in seen_advanced:
            raise ValueError(
                "An advanced field must be distinct from existing controls."
            )
        seen_advanced.add(key)
        kind = definition.get("kind")
        source_type = widget_type(original)
        if kind == "enum":
            options = definition.get("options")
            if not (
                isinstance(options, list)
                and original in options
                and all(widget_type(option) == source_type for option in options)
            ):
                raise ValueError(
                    "An advanced enum needs typed options that include the original value."
                )
        elif kind == "integer":
            if not numeric_widget(original) or not float(original).is_integer():
                raise ValueError("An advanced integer needs an integer input.")
        elif kind not in ("text", "boolean", "number") or kind != source_type:
            raise ValueError("The advanced control type must match the input value.")
        if kind in ("integer", "number"):
            if any(
                key in definition and not is_number(definition[key])
                for key in ("min", "max", "step")
            ):
                raise ValueError("Advanced numeric bounds must be finite.")
            if (
                definition.get("min", -math.inf) > definition.get("max", math.inf)
                or definition.get("step", 1) <= 0
            ):
                raise ValueError("Advanced numeric bounds or increment are invalid.")
    if "legacyFrameform" in profile and type(profile["legacyFrameform"]) is not bool:
        raise ValueError("legacyFrameform must be a boolean.")
    still_ids = profile.get("firstFrameIds")
    if still_ids is not None and not (
        profile.get("firstFrame")
        and isinstance(still_ids, list)
        and len(still_ids) == 2
        and all(
            isinstance(node, str)
            and re.fullmatch(r"[1-9]\d*", node)
            and node not in graph
            for node in still_ids
        )
        and still_ids[0] != still_ids[1]
    ):
        raise ValueError(
            "firstFrameIds must contain two distinct unused numeric node IDs."
        )
    if "firstFramePrefix" in profile and not (
        profile.get("firstFrame")
        and isinstance(profile["firstFramePrefix"], str)
        and profile["firstFramePrefix"]
    ):
        raise ValueError(
            "firstFramePrefix needs a filename prefix and a firstFrame mapping."
        )
    still = profile.get("firstFrame")
    if still is not None and not (
        isinstance(still, list)
        and len(still) == 2
        and isinstance(still[0], str)
        and still[0] in graph
        and type(still[1]) is int
        and still[1] >= 0
    ):
        raise ValueError(
            "firstFrame must identify the verified IMAGE batch output as [node ID, output index]."
        )


def build(args, graph):
    profile = read_json(args.profile)
    validate_profile(graph, profile)
    title = profile.get("title", args.workflow.stem)
    if not isinstance(title, str) or not title.strip():
        raise ValueError("title must be non-empty text.")
    profile["title"] = title
    # Same workflow/profile and filename can restore the same local draft on rebuild.
    profile.setdefault(
        "storageKey",
        hashlib.sha256(safe_json([graph, profile]).encode()).hexdigest()[:16],
    )
    if not isinstance(profile["storageKey"], str) or not re.fullmatch(
        r"[a-zA-Z0-9_-]{1,80}", profile["storageKey"]
    ):
        raise ValueError("storageKey must be a short URL-safe identifier.")
    values = {
        "WORKFLOW_JSON": safe_json(graph),
        "PROFILE_JSON": safe_json(profile),
        "WORKFLOW_TITLE": html.escape(title),
        "OUTPUT_FILENAME": quote(args.output.name),
        "APP_JS": (args.app or ASSETS / "workbench.js").read_text(encoding="utf-8"),
    }
    source = (args.template or ASSETS / "workbench.html").read_text(encoding="utf-8")
    for token in values:
        if source.count(token) != 1:
            raise ValueError(
                f"The workbench template needs exactly one {token} marker."
            )
    legacy = profile.get("legacyFrameform", False)
    values.update(
        {
            "WORKBENCH_HEADING": "视频生成工作台" if legacy else "ComfyUI 生成工作台",
            "WORKBENCH_OVERLINE": "VIDEO WORKSPACE" if legacy else "COMFYUI WORKSPACE",
            "WORKBENCH_PLACEHOLDER": "描述画面、镜头运动和声音…"
            if legacy
            else "输入生成提示词…",
            "WORKBENCH_FOOTER": "FRAMEFORM / VIDEO STUDIO"
            if legacy
            else "FRAMEFORM / COMFYUI",
        }
    )
    # Preserve --template compatibility with previously copied templates.
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        re.sub("|".join(values), lambda match: values[match[0]], source),
        encoding="utf-8",
    )
    print(args.output.resolve())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    inspect = commands.add_parser("inspect", help="print API nodes, fields, and links")
    inspect.add_argument("workflow", type=Path)
    generate = commands.add_parser(
        "build", help="embed the graph and a verified profile"
    )
    generate.add_argument("workflow", type=Path)
    generate.add_argument("profile", type=Path)
    generate.add_argument("output", type=Path)
    generate.add_argument("--template", type=Path, help="optional adapted HTML source")
    generate.add_argument("--app", type=Path, help="optional adapted JavaScript source")
    args = parser.parse_args()
    try:
        graph = load_graph(args.workflow)
        if args.command == "inspect":
            inspect_graph(graph)
        else:
            build(args, graph)
    except (OSError, ValueError, TypeError, AttributeError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
