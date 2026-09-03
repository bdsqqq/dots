{ espIdf
, fetchFromGitHub
, lib
, stdenv
,
}:

let
  componentSource = fetchFromGitHub {
    owner = "espressif";
    repo = "idf-extra-components";
    rev = "1e32ecf000d79db25389d44d29d04b61b72154d4";
    hash = "sha256-xuEWanFvqfdsT8oucighCOG/03aDmnMeQlM2l/iDhzs=";
  };
  libsodiumSource = fetchFromGitHub {
    owner = "jedisct1";
    repo = "libsodium";
    rev = "77e1ce5d6dee871c49ef211222ba18ef0c486bda";
    hash = "sha256-k8u7iNqvjLA0PptbneDyE8zCtutJlV2LirrRb41tmBY=";
  };
in
stdenv.mkDerivation {
  pname = "fleet-mesh-esp32s3-firmware";
  version = "0.1.0";

  src = lib.fileset.toSource {
    root = ./firmware;
    fileset = ./firmware;
  };

  nativeBuildInputs = [ espIdf ];
  dontUseCmakeConfigure = true;
  dontUseNinjaBuild = true;
  dontUseNinjaInstall = true;

  postPatch = ''
    mkdir -p managed_components/espressif__libsodium
    cp -R ${componentSource}/libsodium/. managed_components/espressif__libsodium/
    chmod -R +w managed_components
    mkdir -p managed_components/espressif__libsodium/libsodium
    cp -R ${libsodiumSource}/. managed_components/espressif__libsodium/libsodium/
    chmod -R +w managed_components
  '';

  buildPhase = ''
    runHook preBuild
    export HOME="$TMPDIR/home"
    export IDF_COMPONENT_MANAGER=0
    mkdir -p "$HOME"

    idf.py set-target esp32s3
    idf.py build
    (cd build && esptool.py --chip esp32s3 merge_bin \
      --fill-flash-size 4MB \
      -o flash_image.bin \
      @flash_args)

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm644 build/flash_image.bin "$out/flash_image.bin"
    install -Dm644 build/fleet-mesh-esp32s3.elf "$out/fleet-mesh-esp32s3.elf"
    install -Dm644 partitions.csv "$out/partitions.csv"
    runHook postInstall
  '';

  meta = {
    description = "Fleet mesh recipient firmware for ESP32-S3 and Espressif QEMU";
    license = lib.licenses.mit;
    platforms = [ "aarch64-darwin" ];
  };
}
