// This is a generated file! Please edit source .ksy file and use kaitai-struct-compiler to rebuild

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define(['exports', 'kaitai-struct/KaitaiStream'], factory);
  } else if (typeof exports === 'object' && exports !== null && typeof exports.nodeType !== 'number') {
    factory(exports, require('kaitai-struct/KaitaiStream'));
  } else {
    factory(root.Dat || (root.Dat = {}), root.KaitaiStream);
  }
})(typeof self !== 'undefined' ? self : this, function (Dat_, KaitaiStream) {
var Dat = (function() {
  function Dat(_io, _parent, _root) {
    this._io = _io;
    this._parent = _parent;
    this._root = _root || this;

    this._read();
  }
  Dat.prototype._read = function() {
    this.header = new Header(this._io, this, this._root);
    this._raw_records = this._io.readBytes((this.header.fileLength - this.header.firstRecordPosition) + 1);
    var _io__raw_records = new KaitaiStream(this._raw_records);
    this.records = new Records(_io__raw_records, this, this._root);
  }

  var BffbRecord = Dat.BffbRecord = (function() {
    function BffbRecord(_io, _parent, _root, lenRecordBuffer) {
      this._io = _io;
      this._parent = _parent;
      this._root = _root;
      this.lenRecordBuffer = lenRecordBuffer;

      this._read();
    }
    BffbRecord.prototype._read = function() {
      this.recordBuffer = this._io.readBytes(this.lenRecordBuffer);
    }

    return BffbRecord;
  })();

  var FafaRecord = Dat.FafaRecord = (function() {
    function FafaRecord(_io, _parent, _root, lenRecordBuffer) {
      this._io = _io;
      this._parent = _parent;
      this._root = _root;
      this.lenRecordBuffer = lenRecordBuffer;

      this._read();
    }
    FafaRecord.prototype._read = function() {
      this.recordBuffer = this._io.readBytes(this.lenRecordBuffer);
    }

    return FafaRecord;
  })();

  var FdfdRecord = Dat.FdfdRecord = (function() {
    function FdfdRecord(_io, _parent, _root, lenRecordBuffer) {
      this._io = _io;
      this._parent = _parent;
      this._root = _root;
      this.lenRecordBuffer = lenRecordBuffer;

      this._read();
    }
    FdfdRecord.prototype._read = function() {
      this.recordBuffer = this._io.readBytesFull();
    }

    return FdfdRecord;
  })();

  var FefeRecord = Dat.FefeRecord = (function() {
    function FefeRecord(_io, _parent, _root) {
      this._io = _io;
      this._parent = _parent;
      this._root = _root;

      this._read();
    }
    FefeRecord.prototype._read = function() {
      this.lenRecordBuffer = this._io.readU4le();
      this.blank1 = this._io.readU4le();
      this.unknown1 = this._io.readU4le();
      this.unknown2 = this._io.readU4le();
      this.recordBuffer = this._io.readBytes(this.lenRecordBuffer);
    }

    return FefeRecord;
  })();

  var Header = Dat.Header = (function() {
    function Header(_io, _parent, _root) {
      this._io = _io;
      this._parent = _parent;
      this._root = _root;

      this._read();
    }
    Header.prototype._read = function() {
      this.formatType = this._io.readU4le();
      this.blank2 = this._io.readU4le();
      this.fileLength = this._io.readU4le();
      this.firstRecordPosition = this._io.readU4le();
      this.blank3 = this._io.readU4le();
      this.numberRecordsFafa = this._io.readU4le();
      this.headerBuffer = [];
      for (var i = 0; i < this.firstRecordPosition - 24; i++) {
        this.headerBuffer.push(this._io.readU1());
      }
    }

    return Header;
  })();

  var Record = Dat.Record = (function() {
    function Record(_io, _parent, _root) {
      this._io = _io;
      this._parent = _parent;
      this._root = _root;

      this._read();
    }
    Record.prototype._read = function() {
      this.identifier = this._io.readU2le();
      if (!( ((this.identifier == 65278) || (this.identifier == 65021) || (this.identifier == 64250) || (this.identifier == 64447)) )) {
        throw new KaitaiStream.ValidationNotAnyOfError(this.identifier, this._io, "/types/record/seq/0");
      }
      this.lenRecord = this._io.readU4le();
      switch (this.identifier) {
      case 64250:
        this._raw_record = this._io.readBytes(this.lenRecord - 6);
        var _io__raw_record = new KaitaiStream(this._raw_record);
        this.record = new FafaRecord(_io__raw_record, this, this._root, this.lenRecord - 6);
        break;
      case 64447:
        this._raw_record = this._io.readBytes(this.lenRecord - 6);
        var _io__raw_record = new KaitaiStream(this._raw_record);
        this.record = new BffbRecord(_io__raw_record, this, this._root, this.lenRecord - 6);
        break;
      case 65021:
        this._raw_record = this._io.readBytes(this.lenRecord - 6);
        var _io__raw_record = new KaitaiStream(this._raw_record);
        this.record = new FdfdRecord(_io__raw_record, this, this._root, this.lenRecord - 6);
        break;
      case 65278:
        this._raw_record = this._io.readBytes(this.lenRecord - 6);
        var _io__raw_record = new KaitaiStream(this._raw_record);
        this.record = new FefeRecord(_io__raw_record, this, this._root);
        break;
      default:
        this.record = this._io.readBytes(this.lenRecord - 6);
        break;
      }
    }

    return Record;
  })();

  var Records = Dat.Records = (function() {
    function Records(_io, _parent, _root) {
      this._io = _io;
      this._parent = _parent;
      this._root = _root;

      this._read();
    }
    Records.prototype._read = function() {
      this.record = [];
      var i = 0;
      while (!this._io.isEof()) {
        this.record.push(new Record(this._io, this, this._root));
        i++;
      }
    }

    return Records;
  })();
  Object.defineProperty(Dat.prototype, 'dataTypeId', {
    get: function() {
      if (this._m_dataTypeId !== undefined)
        return this._m_dataTypeId;
      var _pos = this._io.pos;
      this._io.seek(190);
      this._m_dataTypeId = this._io.readU4le();
      this._io.seek(_pos);
      return this._m_dataTypeId;
    }
  });
  Object.defineProperty(Dat.prototype, 'tagName', {
    get: function() {
      if (this._m_tagName !== undefined)
        return this._m_tagName;
      var _pos = this._io.pos;
      this._io.seek(240);
      this._m_tagName = KaitaiStream.bytesToStr(this._io.readBytes(this.tagNameLength), "UTF-8");
      this._io.seek(_pos);
      return this._m_tagName;
    }
  });
  Object.defineProperty(Dat.prototype, 'tagNameLength', {
    get: function() {
      if (this._m_tagNameLength !== undefined)
        return this._m_tagNameLength;
      var _pos = this._io.pos;
      this._io.seek(238);
      this._m_tagNameLength = this._io.readU2le();
      this._io.seek(_pos);
      return this._m_tagNameLength;
    }
  });
  Object.defineProperty(Dat.prototype, 'thirdArrayDimension', {
    get: function() {
      if (this._m_thirdArrayDimension !== undefined)
        return this._m_thirdArrayDimension;
      var _pos = this._io.pos;
      this._io.seek(182);
      this._m_thirdArrayDimension = this._io.readU4le();
      this._io.seek(_pos);
      return this._m_thirdArrayDimension;
    }
  });

  return Dat;
})();
Dat_.Dat = Dat;
});
