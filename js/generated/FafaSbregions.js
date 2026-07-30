// This is a generated file! Please edit source .ksy file and use kaitai-struct-compiler to rebuild

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define(['exports', 'kaitai-struct/KaitaiStream'], factory);
  } else if (typeof exports === 'object' && exports !== null && typeof exports.nodeType !== 'number') {
    factory(exports, require('kaitai-struct/KaitaiStream'));
  } else {
    factory(root.FafaSbregions || (root.FafaSbregions = {}), root.KaitaiStream);
  }
})(typeof self !== 'undefined' ? self : this, function (FafaSbregions_, KaitaiStream) {
var FafaSbregions = (function() {
  function FafaSbregions(_io, _parent, _root) {
    this._io = _io;
    this._parent = _parent;
    this._root = _root || this;

    this._read();
  }
  FafaSbregions.prototype._read = function() {
    this.recordLength = this._io.readU4le();
    this.header = new Header(this._io, this, this._root);
    this.lenRecordBuffer = this._io.readU4le();
    this.recordBuffer = this._io.readBytes(this.lenRecordBuffer);
  }

  var Header = FafaSbregions.Header = (function() {
    function Header(_io, _parent, _root) {
      this._io = _io;
      this._parent = _parent;
      this._root = _root;

      this._read();
    }
    Header.prototype._read = function() {
      this.sbRegions = this._io.readU2le();
      this.identifier = this._io.readU4le();
      this.languageType = KaitaiStream.bytesToStr(KaitaiStream.bytesTerminate(this._io.readBytes(41), 0, false), "UTF-8");
    }

    return Header;
  })();

  return FafaSbregions;
})();
FafaSbregions_.FafaSbregions = FafaSbregions;
});
