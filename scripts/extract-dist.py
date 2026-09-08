import os
import pathlib
import sys
import tarfile

archive, destination = sys.argv[1:]
root = pathlib.Path(destination).resolve()
with tarfile.open(archive, "r:gz") as source:
    members = source.getmembers()
    if len(members) > 50000 or sum(m.size for m in members) > 4 * 1024**3:
        raise ValueError("archive exceeds installation limits")
    names = set()
    links = []
    for member in members:
        name = member.name.rstrip("/")
        parts = name.split("/")
        if not name or parts[0] != "terminal-browser" or any(p in ("", ".", "..") for p in parts) or "\\" in name or "\0" in name:
            raise ValueError("unsafe archive path")
        if name in names or member.mode & 0o7000:
            raise ValueError("duplicate path or special permissions")
        names.add(name)
        if not (member.isdir() or member.isfile() or member.issym()):
            raise ValueError("unsupported archive member")
        if member.issym():
            target = member.linkname
            resolved = os.path.normpath(os.path.join(os.path.dirname(name), target))
            if os.path.isabs(target) or "\\" in target or not resolved.startswith("terminal-browser/"):
                raise ValueError("unsafe archive link")
            links.append((name, target))
    link_names = {name for name, _ in links}
    for name in names:
        if any(str(parent) in link_names for parent in pathlib.PurePosixPath(name).parents):
            raise ValueError("archive writes through a link")
    for member in members:
        target = root / member.name
        if member.isdir():
            target.mkdir(parents=True, exist_ok=True, mode=0o700)
        elif member.isfile():
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with target.open("xb") as output, source.extractfile(member) as input_file:
                while chunk := input_file.read(1024 * 1024):
                    output.write(chunk)
            target.chmod(member.mode & 0o777)
    for name, target in links:
        link = root / name
        link.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        link.symlink_to(target)
    for name, _ in links:
        resolved = (root / name).resolve(strict=True)
        if not resolved.is_relative_to(root / "terminal-browser"):
            raise ValueError("escaping archive link chain")
