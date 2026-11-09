"""Distribution extraction rejects archive paths and links before writing."""
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('extract_package', Path(__file__).parents[1] / 'scripts' / 'extract-package.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ExtractionTests(unittest.TestCase):
    def archive(self, root, name, kind=tarfile.REGTYPE):
        archive = root / 'sample.tgz'
        with tarfile.open(archive, 'w:gz') as target:
            member = tarfile.TarInfo(name)
            member.type = kind
            member.linkname = '../../escape'
            member.size = 2 if kind == tarfile.REGTYPE else 0
            target.addfile(member, io.BytesIO(b'{}') if member.size else None)
        return archive

    def test_regular_package_file(self):
        with tempfile.TemporaryDirectory(prefix='sg-extract-') as directory:
            root = Path(directory)
            module.extract(self.archive(root, 'package/package.json'), root / 'out')
            self.assertEqual((root / 'out/package/package.json').read_bytes(), b'{}')

    def test_rejects_unsafe_paths_and_links_without_output(self):
        for name, kind in [('package/../../escape', tarfile.REGTYPE), ('/package/absolute', tarfile.REGTYPE),
                           ('package/C:/escape', tarfile.REGTYPE), ('package/back\\slash', tarfile.REGTYPE),
                           ('package/link', tarfile.SYMTYPE), ('package/hard', tarfile.LNKTYPE)]:
            with self.subTest(name=name), tempfile.TemporaryDirectory(prefix='sg-extract-') as directory:
                root = Path(directory)
                with self.assertRaises(ValueError):
                    module.extract(self.archive(root, name, kind), root / 'out')
                self.assertFalse((root / 'out').exists())

    def test_refuses_to_overwrite_existing_file(self):
        with tempfile.TemporaryDirectory(prefix='sg-extract-') as directory:
            root = Path(directory)
            target = root / 'out/package/package.json'
            target.parent.mkdir(parents=True)
            target.write_bytes(b'original')
            with self.assertRaises(ValueError):
                module.extract(self.archive(root, 'package/package.json'), root / 'out')
            self.assertEqual(target.read_bytes(), b'original')


if __name__ == '__main__':
    unittest.main()
